import stringWidth from 'string-width';

const textSegmenter = typeof Intl.Segmenter === 'function'
  ? new Intl.Segmenter(undefined, { granularity: 'grapheme' })
  : null;

export type TextAreaRenderRow = {
  text: string;
  before: string;
  cursor: string | null;
  after: string;
  start: number;
  end: number;
};

export function renderTextAreaRows(
  state: { text: string; cursorOffset: number },
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
      const cursorSegment = findTextSegmentAtOffset(text, line.start, line.end, cursorOffset);
      cursorRendered = true;
      if (!cursorSegment) {
        return { ...line, before: line.text, cursor: ' ', after: '' };
      }
      return {
        ...line,
        before: text.slice(line.start, cursorSegment.start),
        cursor: cursorSegment.text,
        after: text.slice(cursorSegment.end, line.end),
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
      rows.push(...wrapTextAreaLine(line, offset, visualWidth));
    }
    offset += line.length;
    if (lineIndex < logicalLines.length - 1) {
      offset += 1;
    }
  }

  return rows.length > 0 ? rows : [{ text: '', start: 0, end: 0 }];
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

  for (const segment of segmentText(line, lineOffset)) {
    const segmentWidth = Math.max(1, stringWidth(segment.text));
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

  for (const segment of segmentText(text.slice(row.start, row.end), row.start)) {
    if (boundedOffset <= segment.start) return column;
    if (boundedOffset < segment.end) return column;
    column += Math.max(1, stringWidth(segment.text));
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

  for (const segment of segmentText(text.slice(row.start, row.end), row.start)) {
    const nextColumn = currentColumn + Math.max(1, stringWidth(segment.text));
    if (nextColumn > targetColumn) return segment.start;
    currentColumn = nextColumn;
  }

  return row.end;
}

function clampCursor(cursorOffset: number, text: string) {
  return Math.max(0, Math.min(text.length, cursorOffset));
}

function findTextSegmentAtOffset(
  text: string,
  start: number,
  end: number,
  cursorOffset: number,
) {
  for (const segment of segmentText(text.slice(start, end), start)) {
    if (cursorOffset >= segment.start && cursorOffset < segment.end) {
      return segment;
    }
  }
  return null;
}

function segmentText(text: string, offset: number) {
  return readTextSegments(text).map((segment) => {
    const start = offset + segment.index;
    return {
      text: segment.text,
      start,
      end: start + segment.text.length,
    };
  });
}

function readTextSegments(text: string): Array<{ text: string; index: number }> {
  if (textSegmenter) {
    return Array.from(textSegmenter.segment(text), (segment) => ({
      text: segment.segment,
      index: segment.index,
    }));
  }

  const segments: Array<{ text: string; index: number }> = [];
  let index = 0;
  for (const textSegment of Array.from(text)) {
    segments.push({ text: textSegment, index });
    index += textSegment.length;
  }
  return segments;
}
