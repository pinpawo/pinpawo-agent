import {
  wrapTextAreaRows,
  type TextAreaLayoutRow,
} from './layout';
import {
  findTextAreaSegmentAtOffset,
  segmentTextAreaText,
} from './textSegments';
import {
  getTextAreaSelectionRange,
  type TextAreaSelection,
} from './selection';

export type TextAreaRenderSegment = {
  text: string;
  selected: boolean;
  cursor: boolean;
};

export type TextAreaRenderRow = TextAreaLayoutRow & {
  before: string;
  cursor: string | null;
  after: string;
  segments?: TextAreaRenderSegment[];
};

export function renderTextAreaRows(
  state: { text: string; cursorOffset: number; selection?: TextAreaSelection },
  width: number,
): TextAreaRenderRow[] {
  const text = state.text;
  const cursorOffset = clampCursor(state.cursorOffset, text);
  const selectionRange = getTextAreaSelectionRange(state.selection, text);
  let cursorRendered = false;

  return wrapTextAreaRows(text, width).map((line) => {
    const segments = selectionRange
      ? buildTextAreaRenderSegments(line, text, cursorOffset, selectionRange)
      : undefined;

    if (!cursorRendered && line.start === line.end && cursorOffset === line.start) {
      cursorRendered = true;
      return { ...line, before: '', cursor: ' ', after: '', ...(segments ? { segments } : {}) };
    }

    if (!cursorRendered && cursorOffset >= line.start && cursorOffset < line.end) {
      const cursorSegment = findTextAreaSegmentAtOffset(text, line.start, line.end, cursorOffset);
      cursorRendered = true;
      if (!cursorSegment) {
        return { ...line, before: line.text, cursor: ' ', after: '', ...(segments ? { segments } : {}) };
      }
      return {
        ...line,
        before: text.slice(line.start, cursorSegment.start),
        cursor: cursorSegment.text,
        after: text.slice(cursorSegment.end, line.end),
        ...(segments ? { segments } : {}),
      };
    }

    if (
      !cursorRendered
      && cursorOffset === line.end
      && (cursorOffset === text.length || text[cursorOffset] === '\n')
    ) {
      cursorRendered = true;
      return { ...line, before: line.text, cursor: ' ', after: '', ...(segments ? { segments } : {}) };
    }

    return { ...line, before: line.text, cursor: null, after: '', ...(segments ? { segments } : {}) };
  });
}

function buildTextAreaRenderSegments(
  row: TextAreaLayoutRow,
  text: string,
  cursorOffset: number,
  selectionRange: { start: number; end: number },
): TextAreaRenderSegment[] {
  if (row.start === row.end) {
    return [{ text: ' ', selected: false, cursor: cursorOffset === row.start }];
  }

  const segments = segmentTextAreaText(text.slice(row.start, row.end), row.start).map((segment) => ({
    text: segment.text,
    selected: segment.start < selectionRange.end && segment.end > selectionRange.start,
    cursor: cursorOffset >= segment.start && cursorOffset < segment.end,
  }));
  if (cursorOffset === row.end && (cursorOffset === text.length || text[cursorOffset] === '\n')) {
    segments.push({ text: ' ', selected: false, cursor: true });
  }
  return segments;
}

function clampCursor(cursorOffset: number, text: string) {
  return Math.max(0, Math.min(text.length, cursorOffset));
}
