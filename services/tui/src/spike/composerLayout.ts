const MIN_CONTENT_ROWS = 1;
const MAX_CONTENT_ROWS = 8;
const FRAME_VERTICAL_CHROME_ROWS = 4;
const FOOTER_FIXED_ROWS = 3;

export function calculateComposerLayout(
  text: string,
  virtualLineCount: number,
) {
  const logicalLineCount = text.split('\n').length;
  const contentRows = clamp(
    Math.max(logicalLineCount, virtualLineCount),
    MIN_CONTENT_ROWS,
    MAX_CONTENT_ROWS,
  );
  const frameHeight = contentRows + FRAME_VERTICAL_CHROME_ROWS;
  return {
    contentRows,
    frameHeight,
    footerHeight: frameHeight + FOOTER_FIXED_ROWS,
  };
}

function clamp(value: number, minimum: number, maximum: number) {
  return Math.max(minimum, Math.min(value, maximum));
}
