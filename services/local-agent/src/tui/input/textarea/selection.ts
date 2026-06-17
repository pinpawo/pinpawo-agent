import { segmentTextAreaText } from './textSegments';

export type TextAreaSelection = {
  anchorOffset: number;
  focusOffset: number;
};

export type TextAreaSelectionRange = {
  start: number;
  end: number;
};

export function normalizeTextAreaSelection(
  selection: TextAreaSelection | null | undefined,
  text: string,
): TextAreaSelection | undefined {
  if (!selection) return undefined;
  const anchorOffset = clampOffset(selection.anchorOffset, text);
  const focusOffset = clampOffset(selection.focusOffset, text);
  if (anchorOffset === focusOffset) return undefined;
  const range = expandRangeToGraphemeBoundaries(
    text,
    Math.min(anchorOffset, focusOffset),
    Math.max(anchorOffset, focusOffset),
  );
  if (range.start === range.end) return undefined;
  return anchorOffset <= focusOffset
    ? { anchorOffset: range.start, focusOffset: range.end }
    : { anchorOffset: range.end, focusOffset: range.start };
}

export function getTextAreaSelectionRange(
  selection: TextAreaSelection | null | undefined,
  text: string,
): TextAreaSelectionRange | null {
  const normalized = normalizeTextAreaSelection(selection, text);
  if (!normalized) return null;
  return {
    start: Math.min(normalized.anchorOffset, normalized.focusOffset),
    end: Math.max(normalized.anchorOffset, normalized.focusOffset),
  };
}

export function hasTextAreaSelection(
  selection: TextAreaSelection | null | undefined,
  text: string,
): boolean {
  return getTextAreaSelectionRange(selection, text) !== null;
}

export function createTextAreaSelectAllSelection(text: string): TextAreaSelection | undefined {
  return text.length === 0
    ? undefined
    : { anchorOffset: 0, focusOffset: text.length };
}

function clampOffset(offset: number, text: string) {
  return Math.max(0, Math.min(text.length, offset));
}

function expandRangeToGraphemeBoundaries(
  text: string,
  start: number,
  end: number,
): TextAreaSelectionRange {
  let nextStart = start;
  let nextEnd = end;

  for (const segment of segmentTextAreaText(text)) {
    if (nextStart > segment.start && nextStart < segment.end) {
      nextStart = segment.start;
    }
    if (nextEnd > segment.start && nextEnd < segment.end) {
      nextEnd = segment.end;
    }
  }

  return { start: nextStart, end: nextEnd };
}
