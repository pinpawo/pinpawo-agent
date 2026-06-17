import {
  measureTextAreaSegmentWidth,
  segmentTextAreaText,
} from './textSegments';

export type TextAreaLayoutRow = {
  text: string;
  start: number;
  end: number;
};

export type TextAreaLayout = {
  rows: TextAreaLayoutRow[];
  cursor: {
    offset: number;
    rowIndex: number;
    column: number;
    isAtFirstVisualRow: boolean;
    isAtLastVisualRow: boolean;
  };
};

export function wrapTextAreaRows(text: string, width: number): TextAreaLayoutRow[] {
  const visualWidth = Math.max(1, width);
  const rows: TextAreaLayoutRow[] = [];
  let offset = 0;
  const logicalLines = text.split('\n');

  for (const [lineIndex, line] of logicalLines.entries()) {
    if (!line) {
      rows.push({ text: '', start: offset, end: offset });
    } else {
      rows.push(...wrapTextAreaLine(line, offset, visualWidth));
    }
    offset += line.length;
    if (lineIndex < logicalLines.length - 1) {
      offset += 1;
    }
  }

  return rows.length > 0 ? rows : [{ text: '', start: 0, end: 0 }];
}

export function measureTextAreaLayout(
  state: { text: string; cursorOffset: number },
  width: number,
): TextAreaLayout {
  const text = state.text;
  const cursorOffset = clampCursor(state.cursorOffset, text);
  const rows = wrapTextAreaRows(text, width);
  const rowIndex = findTextAreaRenderRowIndexForCursor(rows, text, cursorOffset);
  const row = rows[rowIndex] ?? rows[0]!;
  const column = measureTextAreaVisualColumn(row, text, cursorOffset);

  return {
    rows,
    cursor: {
      offset: cursorOffset,
      rowIndex,
      column,
      isAtFirstVisualRow: rowIndex === 0,
      isAtLastVisualRow: rowIndex === rows.length - 1,
    },
  };
}

function wrapTextAreaLine(
  line: string,
  lineOffset: number,
  width: number,
): Array<{ text: string; start: number; end: number }> {
  const rows: Array<{ text: string; start: number; end: number }> = [];
  let rowText = '';
  let rowStart = lineOffset;
  let rowEnd = lineOffset;
  let rowWidth = 0;

  for (const segment of segmentTextAreaText(line, lineOffset)) {
    const segmentWidth = measureTextAreaSegmentWidth(segment.text);
    if (rowWidth > 0 && rowWidth + segmentWidth > width) {
      rows.push({ text: rowText, start: rowStart, end: rowEnd });
      rowText = segment.text;
      rowStart = segment.start;
      rowEnd = segment.end;
      rowWidth = segmentWidth;
      continue;
    }

    rowText += segment.text;
    rowEnd = segment.end;
    rowWidth += segmentWidth;
  }

  if (rowText) {
    rows.push({ text: rowText, start: rowStart, end: rowEnd });
  }

  return rows;
}

export function findTextAreaRenderRowIndexForCursor(
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

export function measureTextAreaVisualColumn(
  row: { start: number; end: number },
  text: string,
  cursorOffset: number,
) {
  const boundedOffset = Math.max(row.start, Math.min(row.end, cursorOffset));
  let column = 0;

  for (const segment of segmentTextAreaText(text.slice(row.start, row.end), row.start)) {
    if (boundedOffset <= segment.start) return column;
    if (boundedOffset < segment.end) return column;
    column += measureTextAreaSegmentWidth(segment.text);
  }

  return column;
}

export function findTextAreaOffsetAtVisualColumn(
  row: { start: number; end: number },
  text: string,
  column: number,
) {
  const targetColumn = Math.max(0, column);
  let currentColumn = 0;

  for (const segment of segmentTextAreaText(text.slice(row.start, row.end), row.start)) {
    const nextColumn = currentColumn + measureTextAreaSegmentWidth(segment.text);
    if (nextColumn > targetColumn) return segment.start;
    currentColumn = nextColumn;
  }

  return row.end;
}

function clampCursor(cursorOffset: number, text: string) {
  return Math.max(0, Math.min(text.length, cursorOffset));
}
