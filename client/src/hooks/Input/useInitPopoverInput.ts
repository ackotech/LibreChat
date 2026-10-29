import { useCallback } from 'react';
import { getMentionQueryContext, getPersonMentionQueryContext } from './mentions';

/** Creates a callback ref that focuses the popover input and transfers command text into search. */
const useInitPopoverInput = ({
  inputRef,
  textAreaRef,
  commandChar,
  preserveTextAfterCursor = false,
  setSearchValue,
  setOpen,
  setPersonMode,
}: {
  inputRef: React.MutableRefObject<HTMLInputElement | null>;
  textAreaRef: React.MutableRefObject<HTMLTextAreaElement | null>;
  commandChar: string;
  preserveTextAfterCursor?: boolean;
  setSearchValue: (value: string) => void;
  setOpen: (value: boolean) => void;
  setPersonMode?: (value: boolean) => void;
}) =>
  useCallback(
    (node: HTMLInputElement | null) => {
      inputRef.current = node;
      if (!node) {
        return;
      }
      const textarea = textAreaRef.current;
      const text = textarea?.value;
      const selectionStart = textarea?.selectionStart;
      node.focus();
      setOpen(true);
      if (!textarea || typeof text !== 'string' || typeof selectionStart !== 'number') {
        return;
      }
      if (commandChar === '@') {
        const personContext = getPersonMentionQueryContext(text, selectionStart);
        if (personContext) {
          setPersonMode?.(true);
          setSearchValue(personContext.query);
          textarea.value = `${text.slice(0, personContext.start)}${text.slice(selectionStart)}`;
          textarea.setSelectionRange(personContext.start, personContext.start);
          textarea.dispatchEvent(new Event('input', { bubbles: true }));
          return;
        }
        setPersonMode?.(false);
        const mentionContext = getMentionQueryContext(text, selectionStart);
        if (mentionContext) {
          setSearchValue(mentionContext.query);
          textarea.value = `${text.slice(0, mentionContext.start)}${text.slice(selectionStart)}`;
          textarea.setSelectionRange(mentionContext.start, mentionContext.start);
          textarea.dispatchEvent(new Event('input', { bubbles: true }));
          return;
        }
      }
      if (!text.startsWith(commandChar) || selectionStart < commandChar.length) {
        return;
      }
      const commandEnd = preserveTextAfterCursor ? selectionStart : text.length;
      if (commandEnd > commandChar.length) {
        setSearchValue(text.slice(commandChar.length, commandEnd));
      }
      textarea.value = preserveTextAfterCursor ? text.slice(selectionStart) : '';
      textarea.setSelectionRange(0, 0);
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
    },
    [
      inputRef,
      textAreaRef,
      commandChar,
      preserveTextAfterCursor,
      setSearchValue,
      setOpen,
      setPersonMode,
    ],
  );

export default useInitPopoverInput;
