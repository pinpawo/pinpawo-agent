import {
  wrapTextAreaRows,
  type TextAreaLayoutRow,
} from './layout';
import { findTextAreaSegmentAtOffset } from './textSegments';

export type TextAreaRenderRow = TextAreaLayoutRow & {
  before: string;
  cursor: string | null;
  after: string;
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
      const cursorSegment = findTextAreaSegmentAtOffset(text, line.start, line.end, cursorOffset);
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

function clampCursor(cursorOffset: number, text: string) {
  return Math.max(0, Math.min(text.length, cursorOffset));
}
