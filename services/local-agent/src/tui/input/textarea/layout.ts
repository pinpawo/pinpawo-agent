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

function clampCursor(cursorOffset: number, text: string) {
  return Math.max(0, Math.min(text.length, cursorOffset));
}
