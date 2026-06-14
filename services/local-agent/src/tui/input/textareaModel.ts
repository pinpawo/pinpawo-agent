import type { TuiKeyInput } from './keymap';

export type TextAreaModel = {
  text: string;
  cursorOffset: number;
};

export type TextAreaRenderRow = {
  text: string;
  before: string;
  cursor: string | null;
  after: string;
  start: number;
  end: number;
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
  const text = state.text;
  const cursorOffset = clampCursor(state.cursorOffset, text);
  const width = options.width ?? Number.MAX_SAFE_INTEGER;

  if (key.ctrl) {
    switch (input) {
      case 'a':
        return createTextAreaModel(text, findLogicalLineStart(text, cursorOffset));
      case 'e':
        return createTextAreaModel(text, findLogicalLineEnd(text, cursorOffset));
      case 'k':
        return replaceRange(text, cursorOffset, findLogicalLineEnd(text, cursorOffset), '', cursorOffset);
      case 'u': {
        const lineStart = findLogicalLineStart(text, cursorOffset);
        return replaceRange(text, lineStart, cursorOffset, '', lineStart);
      }
      case 'w': {
        const wordStart = findPreviousWordStart(text, cursorOffset);
        return replaceRange(text, wordStart, cursorOffset, '', wordStart);
      }
      default:
        return createTextAreaModel(text, cursorOffset);
    }
  }

  if (key.leftArrow) {
    return createTextAreaModel(text, cursorOffset - 1);
  }
  if (key.rightArrow) {
    return createTextAreaModel(text, cursorOffset + 1);
  }
  if (key.upArrow) {
    return createTextAreaModel(text, moveCursorVertically(text, cursorOffset, width, -1));
  }
  if (key.downArrow) {
    return createTextAreaModel(text, moveCursorVertically(text, cursorOffset, width, 1));
  }
  if (key.home) {
    return createTextAreaModel(text, findLogicalLineStart(text, cursorOffset));
  }
  if (key.end) {
    return createTextAreaModel(text, findLogicalLineEnd(text, cursorOffset));
  }
  if (key.backspace) {
    if (cursorOffset === 0) return createTextAreaModel(text, cursorOffset);
    return replaceRange(text, cursorOffset - 1, cursorOffset, '', cursorOffset - 1);
  }
  if (key.delete) {
    if (cursorOffset === text.length) return createTextAreaModel(text, cursorOffset);
    return replaceRange(text, cursorOffset, cursorOffset + 1, '', cursorOffset);
  }
  if (isTextAreaNewlineInput(input, key)) {
    return replaceRange(text, cursorOffset, cursorOffset, '\n', cursorOffset + 1);
  }

  const inserted = normalizeTextAreaTextInput(input);
  if (!inserted) {
    return createTextAreaModel(text, cursorOffset);
  }
  return replaceRange(text, cursorOffset, cursorOffset, inserted, cursorOffset + inserted.length);
}

export function renderTextAreaRows(
  state: TextAreaModel,
  width: number,
): TextAreaRenderRow[] {
  const text = state.text;
  const cursorOffset = clampCursor(state.cursorOffset, text);
  let cursorRendered = false;

  return wrapTextAreaRows(text, width).map((line) => {
    if (!cursorRendered && line.start === line.end && cursorOffset === line.start) {
      cursorRendered = true;
      return { ...line, before: '', cursor: ' ', after: '' };
    }

    if (!cursorRendered && cursorOffset >= line.start && cursorOffset < line.end) {
      const localOffset = cursorOffset - line.start;
      cursorRendered = true;
      return {
        ...line,
        before: line.text.slice(0, localOffset),
        cursor: text[cursorOffset] === '\n' ? ' ' : text[cursorOffset] ?? ' ',
        after: line.text.slice(localOffset + 1),
      };
    }

    if (
      !cursorRendered
      && cursorOffset === line.end
      && (cursorOffset === text.length || text[cursorOffset] === '\n')
    ) {
      cursorRendered = true;
      return { ...line, before: line.text, cursor: ' ', after: '' };
    }

    return { ...line, before: line.text, cursor: null, after: '' };
  });
}

export function wrapTextAreaRows(text: string, width: number): Array<{
  text: string;
  start: number;
  end: number;
}> {
  const visualWidth = Math.max(1, width);
  const rows: Array<{ text: string; start: number; end: number }> = [];
  let offset = 0;
  const logicalLines = text.split('\n');

  for (const [lineIndex, line] of logicalLines.entries()) {
    if (!line) {
      rows.push({ text: '', start: offset, end: offset });
    } else {
      for (let start = 0; start < line.length; start += visualWidth) {
        const chunk = line.slice(start, start + visualWidth);
        rows.push({
          text: chunk,
          start: offset + start,
          end: offset + start + chunk.length,
        });
      }
    }
    offset += line.length;
    if (lineIndex < logicalLines.length - 1) {
      offset += 1;
    }
  }

  return rows.length > 0 ? rows : [{ text: '', start: 0, end: 0 }];
}

export function isTextAreaNewlineInput(input: string, key: TuiKeyInput) {
  return Boolean(key.shift && key.return)
    || input === '\x1b[13;2u'
    || input === '\x1b[13;2~'
    || input === '\x1b[27;2;13~'
    || input === '[13;2u'
    || input === '[13;2~'
    || input === '[27;2;13~';
}

export function isTextAreaControlSequence(input: string) {
  return /^(?:\x1b)?\[[0-9;?]*[A-Za-z~]$/.test(input);
}

export function normalizeTextAreaTextInput(input: string) {
  if (!input) return '';
  if (isTextAreaControlSequence(input)) return '';

  const text = input
    .replace(/(?:\x1b)?\[200~/g, '')
    .replace(/(?:\x1b)?\[201~/g, '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n');

  if (isTextAreaControlSequence(text)) return '';
  return text;
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
  const rowIndex = findRenderRowIndexForCursor(rows, text, cursorOffset);
  const row = rows[rowIndex] ?? rows[0]!;
  const targetRow = rows[Math.max(0, Math.min(rows.length - 1, rowIndex + direction))] ?? row;
  const column = Math.max(0, Math.min(cursorOffset - row.start, row.end - row.start));
  return targetRow.start + Math.min(column, targetRow.end - targetRow.start);
}

function findRenderRowIndexForCursor(
  rows: Array<{ start: number; end: number }>,
  text: string,
  cursorOffset: number,
) {
  const index = rows.findIndex((row) => {
    if (row.start === row.end) return cursorOffset === row.start;
    if (cursorOffset >= row.start && cursorOffset < row.end) return true;
    return cursorOffset === row.end && (cursorOffset === text.length || text[cursorOffset] === '\n');
  });
  return index >= 0 ? index : rows.length - 1;
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
