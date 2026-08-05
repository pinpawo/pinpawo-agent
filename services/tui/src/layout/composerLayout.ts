const MIN_VISIBLE_CONTENT_ROWS = 4;
const MAX_VISIBLE_CONTENT_ROWS = 5;
const FRAME_BORDER_ROWS = 2;
const STATUS_ROWS = 2;
const COMMAND_PALETTE_ROWS = 5;

export function calculateComposerLayout(
  text: string,
  virtualLineCount: number,
  options: {
    commandPalette?: boolean;
    persistentHeader?: boolean;
    planHeight?: number;
  } = {},
) {
  if (options.commandPalette) {
    return withFooterHeight({
      visibleContentRows: 1,
      frameHeight: 2,
      headerHeight: COMMAND_PALETTE_ROWS,
      liveHeight: 0,
      statusHeight: STATUS_ROWS,
      ...(options.planHeight ? { planHeight: options.planHeight } : {}),
    });
  }
  const logicalLineCount = text.split('\n').length;
  const maxVisibleContentRows = options.persistentHeader
    ? MAX_VISIBLE_CONTENT_ROWS - 1
    : MAX_VISIBLE_CONTENT_ROWS;
  const minVisibleContentRows = options.persistentHeader
    ? MIN_VISIBLE_CONTENT_ROWS - 1
    : MIN_VISIBLE_CONTENT_ROWS;
  const visibleContentRows = clamp(
    Math.max(logicalLineCount, virtualLineCount) + 2,
    minVisibleContentRows,
    maxVisibleContentRows,
  );
  const frameHeight = visibleContentRows + FRAME_BORDER_ROWS;

  return withFooterHeight({
    visibleContentRows,
    frameHeight,
    headerHeight: options.persistentHeader ? 1 : 0,
    liveHeight: 1,
    statusHeight: STATUS_ROWS,
    ...(options.planHeight ? { planHeight: options.planHeight } : {}),
  });
}

function withFooterHeight<T extends {
  frameHeight: number;
  headerHeight: number;
  liveHeight: number;
  statusHeight: number;
  planHeight?: number;
}>(layout: T) {
  return {
    ...layout,
    footerHeight: layout.frameHeight
      + layout.headerHeight
      + layout.liveHeight
      + layout.statusHeight
      + (layout.planHeight ?? 0),
  };
}

function clamp(value: number, minimum: number, maximum: number) {
  return Math.max(minimum, Math.min(value, maximum));
}
