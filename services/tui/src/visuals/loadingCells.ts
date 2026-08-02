import {
  bg,
  fg,
  RGBA,
  StyledText,
  type ColorInput,
} from '@opentui/core';

const LOADING_CELL_FRAMES = [
  [true, false, false],
  [false, true, false],
  [false, false, true],
  [false, true, false],
] as const;

export const LOADING_CELL_FRAME_COUNT = LOADING_CELL_FRAMES.length;
export const LOADING_CELL_WIDTH = LOADING_CELL_FRAMES[0].length;

const DEFAULT_ACTIVE_COLOR = '#69c0c8';
const DEFAULT_INACTIVE_COLOR = '#30484b';

export function loadingCellFrame(frame: number): readonly boolean[] {
  return LOADING_CELL_FRAMES[
    Math.max(0, Math.floor(frame)) % LOADING_CELL_FRAME_COUNT
  ];
}

export function buildLoadingCellLine(
  text: string,
  frame: number,
  options: {
    prefix?: string;
    activeColor?: ColorInput;
    inactiveColor?: ColorInput;
    textColor?: ColorInput;
  } = {},
) {
  const textColor = options.textColor ?? RGBA.defaultForeground();
  const chunks = options.prefix
    ? [fg(textColor)(options.prefix)]
    : [];
  chunks.push(...loadingCellFrame(frame).map((active) => (
    bg(active
      ? options.activeColor ?? DEFAULT_ACTIVE_COLOR
      : options.inactiveColor ?? DEFAULT_INACTIVE_COLOR)(' ')
  )));
  chunks.push(fg(textColor)(` ${text}`));
  return new StyledText(chunks);
}
