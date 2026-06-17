import stringWidth from 'string-width';

const textSegmenter = typeof Intl.Segmenter === 'function'
  ? new Intl.Segmenter(undefined, { granularity: 'grapheme' })
  : null;

export type TextAreaTextSegment = {
  text: string;
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
