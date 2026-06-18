import stringWidth from 'string-width';

const textSegmenter = typeof Intl.Segmenter === 'function'
  ? new Intl.Segmenter(undefined, { granularity: 'grapheme' })
  : null;

export type TextAreaTextSegment = {
  text: string;
  start: number;
  end: number;
};

export type TextAreaTextRange = {
  start: number;
  end: number;
};

export function measureTextAreaSegmentWidth(text: string) {
  return Math.max(1, stringWidth(text));
}

export function segmentTextAreaText(text: string, offset = 0): TextAreaTextSegment[] {
  return readTextSegments(text).map((segment) => {
    const start = offset + segment.index;
    return {
      text: segment.text,
      start,
      end: start + segment.text.length,
    };
  });
}

export function findTextAreaSegmentAtOffset(
  text: string,
  start: number,
  end: number,
  cursorOffset: number,
) {
  for (const segment of segmentTextAreaText(text.slice(start, end), start)) {
    if (cursorOffset >= segment.start && cursorOffset < segment.end) {
      return segment;
    }
  }
  return null;
}

export function findPreviousTextAreaSegmentRange(
  text: string,
  cursorOffset: number,
): TextAreaTextRange {
  const boundedOffset = clampOffset(cursorOffset, text);
  let previousRange = { start: 0, end: 0 };

  for (const segment of segmentTextAreaText(text)) {
    const range = { start: segment.start, end: segment.end };
    if (boundedOffset <= segment.start) return previousRange;
    if (boundedOffset <= segment.end) return range;
    previousRange = range;
  }

  return previousRange;
}

export function findNextTextAreaSegmentRange(
  text: string,
  cursorOffset: number,
): TextAreaTextRange {
  const boundedOffset = clampOffset(cursorOffset, text);

  for (const segment of segmentTextAreaText(text)) {
    if (boundedOffset < segment.end) {
      return { start: segment.start, end: segment.end };
    }
  }

  return { start: text.length, end: text.length };
}

export function expandTextAreaRangeToSegmentBoundaries(
  text: string,
  start: number,
  end: number,
): TextAreaTextRange {
  let nextStart = clampOffset(start, text);
  let nextEnd = clampOffset(end, text);
  if (nextStart > nextEnd) {
    [nextStart, nextEnd] = [nextEnd, nextStart];
  }

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

function clampOffset(offset: number, text: string) {
  return Math.max(0, Math.min(text.length, offset));
}
