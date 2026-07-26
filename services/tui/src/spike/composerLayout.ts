const MIN_VISIBLE_CONTENT_ROWS = 3;
const MAX_VISIBLE_CONTENT_ROWS = 5;
const FRAME_BORDER_ROWS = 2;
const FIXED_FOOTER_ROWS = 8;
const STATUS_ROWS = 1;

export function calculateComposerLayout(
  text: string,
  virtualLineCount: number,
) {
  const logicalLineCount = text.split('\n').length;
  const visibleContentRows = clamp(
    Math.max(logicalLineCount, virtualLineCount) + 2,
    MIN_VISIBLE_CONTENT_ROWS,
    MAX_VISIBLE_CONTENT_ROWS,
  );
  const frameHeight = visibleContentRows + FRAME_BORDER_ROWS;
  const auxiliaryRows = FIXED_FOOTER_ROWS - STATUS_ROWS - frameHeight;

  return {
    visibleContentRows,
    frameHeight,
    headerHeight: auxiliaryRows >= 2 ? 1 : 0,
    liveHeight: auxiliaryRows >= 1 ? 1 : 0,
  };
}

function clamp(value: number, minimum: number, maximum: number) {
  return Math.max(minimum, Math.min(value, maximum));
}
