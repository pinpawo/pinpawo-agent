const MIN_CONTENT_ROWS = 1;
const MAX_CONTENT_ROWS = 3;
const FRAME_VERTICAL_CHROME_ROWS = 4;
const FIXED_FOOTER_ROWS = 8;
const STATUS_ROWS = 1;

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
  const auxiliaryRows = FIXED_FOOTER_ROWS - STATUS_ROWS - frameHeight;

  return {
    contentRows,
    frameHeight,
    headerHeight: auxiliaryRows >= 2 ? 1 : 0,
    liveHeight: auxiliaryRows >= 1 ? 1 : 0,
  };
}

function clamp(value: number, minimum: number, maximum: number) {
  return Math.max(minimum, Math.min(value, maximum));
}
