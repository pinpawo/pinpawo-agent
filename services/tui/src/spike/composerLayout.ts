const MIN_VISIBLE_CONTENT_ROWS = 3;
const MAX_VISIBLE_CONTENT_ROWS = 5;
const FRAME_BORDER_ROWS = 2;
const FIXED_FOOTER_ROWS = 9;
const STATUS_ROWS = 2;

export function calculateComposerLayout(
  text: string,
  virtualLineCount: number,
  options: { persistentHeader?: boolean } = {},
) {
  const logicalLineCount = text.split('\n').length;
  const maxVisibleContentRows = options.persistentHeader
    ? MAX_VISIBLE_CONTENT_ROWS - 1
    : MAX_VISIBLE_CONTENT_ROWS;
  const visibleContentRows = clamp(
    Math.max(logicalLineCount, virtualLineCount) + 2,
    MIN_VISIBLE_CONTENT_ROWS,
    maxVisibleContentRows,
  );
  const frameHeight = visibleContentRows + FRAME_BORDER_ROWS;
  const auxiliaryRows = FIXED_FOOTER_ROWS - STATUS_ROWS - frameHeight;
  const headerHeight = options.persistentHeader
    ? 1
    : auxiliaryRows >= 2
      ? 1
      : 0;

  return {
    visibleContentRows,
    frameHeight,
    headerHeight,
    liveHeight: auxiliaryRows - headerHeight >= 1 ? 1 : 0,
  };
}

function clamp(value: number, minimum: number, maximum: number) {
  return Math.max(minimum, Math.min(value, maximum));
}
