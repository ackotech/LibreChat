#!/bin/sh
# Replace the application tree with a copy that contains no symlinks.
# node_modules/.bin entries are regular files that exec the package file they
# used to point at, so a copied shim cannot break require('..').
set -eu

if [ "$#" -ne 1 ] || [ ! -d "$1" ]; then
  echo "usage: dereference-app.sh <application-directory>" >&2
  exit 1
fi

root=$(CDPATH= cd "$1" && pwd)
root=$(readlink -f "$root")
parent=$(dirname "$root")
name=$(basename "$root")
dest="$parent/$name.dereferenced"
if [ -e "$dest" ]; then
  echo "dereference destination already exists: $dest" >&2
  exit 1
fi

manifest=$(mktemp)
links=$(mktemp)
trap 'rm -f "$manifest" "$links"' EXIT
find "$root" -type l -path '*/node_modules/.bin/*' > "$links"

while IFS= read -r link; do
  [ -n "$link" ] || continue
  resolved=$(readlink -f "$link") || {
    echo "unresolved bin link: $link" >&2
    exit 1
  }
  case "$resolved" in
    "$root"/*) ;;
    *)
      echo "bin link target is outside the application tree: $link" >&2
      exit 1
      ;;
  esac
  rel_link=${link#"$root"/}
  rel_target=${resolved#"$root"/}
  case "$rel_link$rel_target" in
    *[[:space:]]*|*\'*|*\"*|*\\*)
      echo "unsupported bin path: $rel_link" >&2
      exit 1
      ;;
  esac
  printf '%s\t%s\n' "$rel_link" "$rel_target" >> "$manifest"
done < "$links"

cp -R -L -p "$root" "$dest"
rm -rf "$root"
mv "$dest" "$root"

while IFS= read -r row; do
  [ -n "$row" ] || continue
  rel_link=${row%%	*}
  rel_target=${row#*	}
  target="$root/$rel_target"
  bin="$root/$rel_link"
  if [ ! -f "$target" ]; then
    echo "missing package bin target: $rel_target" >&2
    exit 1
  fi
  printf '%s\n' '#!/bin/sh' "exec '$target' \"\$@\"" > "$bin"
  chmod 755 "$bin"
done < "$manifest"

remaining=$(find "$root" -type l -print || true)
if [ -n "$remaining" ]; then
  echo "Application symlinks remain after dereferencing:" >&2
  printf '%s\n' "$remaining" >&2
  exit 1
fi
