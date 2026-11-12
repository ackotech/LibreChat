#!/bin/sh
# Seam: the runtime dereference step. A node_modules/.bin entry must still
# load its package after every application symlink is replaced by a file.
set -eu

root=$(CDPATH= cd "$(dirname "$0")" && pwd)
script=$root/dereference-app.sh
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

app=$work/app
mkdir -p "$app/node_modules/fixture-bin/src/bin" "$app/node_modules/.bin" "$app/plain"
printf '%s\n' '{"name":"fixture-bin","version":"1.0.0","main":"src/index.js"}' > "$app/node_modules/fixture-bin/package.json"
printf '%s\n' 'module.exports = { name: "fixture-bin" };' > "$app/node_modules/fixture-bin/src/index.js"
# Same layout as cross-env: src/bin/cli.js does require('..'), which loads src/index.js.
cat > "$app/node_modules/fixture-bin/src/bin/cli.js" <<'EOF'
#!/usr/bin/env node
const pkg = require('..');
if (!pkg || pkg.name !== 'fixture-bin') {
  process.stderr.write('package require failed\n');
  process.exit(2);
}
process.stdout.write('loaded\n');
EOF
chmod 755 "$app/node_modules/fixture-bin/src/bin/cli.js"
ln -s ../fixture-bin/src/bin/cli.js "$app/node_modules/.bin/cli"
printf '%s\n' 'kept' > "$app/plain/file"
ln -s plain/file "$app/copied-file"

sh "$script" "$app"

if [ -L "$app/node_modules/.bin/cli" ] || [ -L "$app/copied-file" ]; then
  echo "expected no remaining application symlinks" >&2
  exit 1
fi
if [ -n "$(find "$app" -type l -print)" ]; then
  echo "application symlinks remain" >&2
  exit 1
fi
if [ "$(cat "$app/copied-file")" != "kept" ]; then
  echo "dereferenced file content was lost" >&2
  exit 1
fi

# npm run executes the .bin entry through PATH, the same way `npm run backend` starts cross-env.
output=$(PATH="$app/node_modules/.bin:$PATH" sh -c 'cli')
if [ "$output" != "loaded" ]; then
  echo "bin entry did not load its package: $output" >&2
  exit 1
fi

echo "dereference-app: bin entry loads after symlink replacement"
