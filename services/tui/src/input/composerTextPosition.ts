import stringWidth from 'string-width';
import type { FileMentionInput } from './fileMention';

type ComposerTextEditor = {
  plainText: string;
  cursorOffset: number;
  getTextRange(startOffset: number, endOffset: number): string;
  setCursor(row: number, column: number): void;
};

export function readComposerTextInput(
  editor: ComposerTextEditor,
): FileMentionInput {
  return {
    text: editor.plainText,
    cursorOffset: editor.getTextRange(0, editor.cursorOffset).length,
  };
}

export function placeComposerCursorAtTextOffset(
  editor: ComposerTextEditor,
  text: string,
  offset: number,
) {
  const prefix = text.slice(
    0,
    Math.max(0, Math.min(offset, text.length)),
  );
  const lines = prefix.split('\n');
  editor.setCursor(
    lines.length - 1,
    stringWidth(lines.at(-1) ?? ''),
  );
}
