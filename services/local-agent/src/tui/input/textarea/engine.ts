import {
  toCanonicalInputEvent,
  type CanonicalInputEvent,
} from '../canonicalInput';
import type { TuiKeyInput } from '../keyInput';
import {
  findTextAreaOffsetAtVisualColumn,
  findTextAreaRenderRowIndexForCursor,
  measureTextAreaVisualColumn,
  wrapTextAreaRows,
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
  const text = state.text;
  const cursorOffset = clampCursor(state.cursorOffset, text);
  const width = options.width ?? Number.MAX_SAFE_INTEGER;

  switch (event.type) {
    case 'text.insert':
    case 'text.paste':
      return replaceRange(text, cursorOffset, cursorOffset, event.text, cursorOffset + event.text.length);
    case 'text.delete.backward':
      if (cursorOffset === 0) return createTextAreaModel(text, cursorOffset);
      return replaceRange(text, cursorOffset - 1, cursorOffset, '', cursorOffset - 1);
    case 'text.delete.forward':
      if (cursorOffset === text.length) return createTextAreaModel(text, cursorOffset);
      return replaceRange(text, cursorOffset, cursorOffset + 1, '', cursorOffset);
    case 'text.delete.word.backward': {
      const wordStart = findPreviousWordStart(text, cursorOffset);
      return replaceRange(text, wordStart, cursorOffset, '', wordStart);
    }
    case 'text.delete.to.line.start': {
      const lineStart = findLogicalLineStart(text, cursorOffset);
      return replaceRange(text, lineStart, cursorOffset, '', lineStart);
    }
    case 'text.delete.to.line.end':
      return replaceRange(text, cursorOffset, findLogicalLineEnd(text, cursorOffset), '', cursorOffset);
    case 'cursor.left':
      return createTextAreaModel(text, cursorOffset - 1);
    case 'cursor.right':
      return createTextAreaModel(text, cursorOffset + 1);
    case 'cursor.up':
      return createTextAreaModel(text, moveCursorVertically(text, cursorOffset, width, -1));
    case 'cursor.down':
      return createTextAreaModel(text, moveCursorVertically(text, cursorOffset, width, 1));
    case 'cursor.line.start':
      return createTextAreaModel(text, findLogicalLineStart(text, cursorOffset));
    case 'cursor.line.end':
      return createTextAreaModel(text, findLogicalLineEnd(text, cursorOffset));
    case 'newline':
      return replaceRange(text, cursorOffset, cursorOffset, '\n', cursorOffset + 1);
    default:
      return createTextAreaModel(text, cursorOffset);
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
  const rows = wrapTextAreaRows(text, width);
  const rowIndex = findTextAreaRenderRowIndexForCursor(rows, text, cursorOffset);
  const row = rows[rowIndex] ?? rows[0]!;
  const targetRow = rows[Math.max(0, Math.min(rows.length - 1, rowIndex + direction))] ?? row;
  const column = measureTextAreaVisualColumn(row, text, cursorOffset);
  return findTextAreaOffsetAtVisualColumn(targetRow, text, column);
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
