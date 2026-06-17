import {
  toCanonicalInputEvent,
  type CanonicalInputEvent,
} from '../canonicalInput';
import type { TuiKeyInput } from '../keyInput';
import {
  toTextAreaCommand,
  type TextAreaCommand,
} from './commands';
import {
  findTextAreaOffsetAtVisualColumn,
  measureTextAreaLayout,
} from './layout';

export type TextAreaModel = {
  text: string;
  cursorOffset: number;
};

export function createTextAreaModel(text = '', cursorOffset = text.length): TextAreaModel {
  return {
    text,
    cursorOffset: clampCursor(cursorOffset, text),
  };
}

export function applyTextAreaInput(
  input: string,
  key: TuiKeyInput,
  state: TextAreaModel,
  options: { width?: number } = {},
): TextAreaModel {
  return applyTextAreaInputEvent(toCanonicalInputEvent({ input, key }), state, options);
}

export function applyTextAreaInputEvent(
  event: CanonicalInputEvent,
  state: TextAreaModel,
  options: { width?: number } = {},
): TextAreaModel {
  const command = toTextAreaCommand(event);
  if (!command) return createTextAreaModel(state.text, state.cursorOffset);
  return applyTextAreaCommand(command, state, options);
}

export function applyTextAreaCommand(
  command: TextAreaCommand,
  state: TextAreaModel,
  options: { width?: number } = {},
): TextAreaModel {
  const text = state.text;
  const cursorOffset = clampCursor(state.cursorOffset, text);
  const width = options.width ?? Number.MAX_SAFE_INTEGER;

  switch (command.type) {
    case 'insert':
    case 'paste':
      return replaceRange(text, cursorOffset, cursorOffset, command.text, cursorOffset + command.text.length);
    case 'deleteBackward':
      if (cursorOffset === 0) return createTextAreaModel(text, cursorOffset);
      return replaceRange(text, cursorOffset - 1, cursorOffset, '', cursorOffset - 1);
    case 'deleteForward':
      if (cursorOffset === text.length) return createTextAreaModel(text, cursorOffset);
      return replaceRange(text, cursorOffset, cursorOffset + 1, '', cursorOffset);
    case 'deleteWordBackward': {
      const wordStart = findPreviousWordStart(text, cursorOffset);
      return replaceRange(text, wordStart, cursorOffset, '', wordStart);
    }
    case 'deleteToLineStart': {
      const lineStart = findLogicalLineStart(text, cursorOffset);
      return replaceRange(text, lineStart, cursorOffset, '', lineStart);
    }
    case 'deleteToLineEnd':
      return replaceRange(text, cursorOffset, findLogicalLineEnd(text, cursorOffset), '', cursorOffset);
    case 'moveLeft':
      return createTextAreaModel(text, cursorOffset - 1);
    case 'moveRight':
      return createTextAreaModel(text, cursorOffset + 1);
    case 'moveUp':
      return createTextAreaModel(text, moveCursorVertically(text, cursorOffset, width, -1));
    case 'moveDown':
      return createTextAreaModel(text, moveCursorVertically(text, cursorOffset, width, 1));
    case 'moveLineStart':
      return createTextAreaModel(text, findLogicalLineStart(text, cursorOffset));
    case 'moveLineEnd':
      return createTextAreaModel(text, findLogicalLineEnd(text, cursorOffset));
    case 'newline':
      return replaceRange(text, cursorOffset, cursorOffset, '\n', cursorOffset + 1);
  }
}

function replaceRange(
  text: string,
  start: number,
  end: number,
  replacement: string,
  cursorOffset: number,
): TextAreaModel {
  const nextText = text.slice(0, start) + replacement + text.slice(end);
  return createTextAreaModel(nextText, cursorOffset);
}

function moveCursorVertically(
  text: string,
  cursorOffset: number,
  width: number,
  direction: -1 | 1,
) {
  const layout = measureTextAreaLayout({ text, cursorOffset }, width);
  const targetRowIndex = Math.max(
    0,
    Math.min(layout.rows.length - 1, layout.cursor.rowIndex + direction),
  );
  const targetRow = layout.rows[targetRowIndex] ?? layout.rows[layout.cursor.rowIndex]!;
  return findTextAreaOffsetAtVisualColumn(targetRow, text, layout.cursor.column);
}

function findLogicalLineStart(text: string, cursorOffset: number) {
  return text.lastIndexOf('\n', Math.max(0, cursorOffset - 1)) + 1;
}

function findLogicalLineEnd(text: string, cursorOffset: number) {
  const nextNewline = text.indexOf('\n', cursorOffset);
  return nextNewline === -1 ? text.length : nextNewline;
}

function findPreviousWordStart(text: string, cursorOffset: number) {
  let start = cursorOffset;
  while (start > 0 && /\s/.test(text[start - 1]!)) start -= 1;
  while (start > 0 && !/\s/.test(text[start - 1]!)) start -= 1;
  return start;
}

function clampCursor(cursorOffset: number, text: string) {
  return Math.max(0, Math.min(text.length, cursorOffset));
}
