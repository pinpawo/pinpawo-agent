import type { AgentSession } from '@pinpawo/agent-session';
import { truncateTerminalLine } from '../text/terminalText';
import { renderHalfBlockRaster } from '../visuals/terminalRaster';
import { TUI_VERSION } from '../version';

const PAW_RASTER = [
  '.....#...#......',
  '....###.###.....',
  '....###.###.....',
  '....###.###.....',
  '..#..#...#..#...',
  '.###.......###..',
  '.###..###..###..',
  '.##..#####..##..',
  '....#######.....',
  '...#########....',
  '..###########...',
  '..###########...',
  '...#########....',
  '....###.###.....',
] as const;

const PAW_LINES = renderHalfBlockRaster(PAW_RASTER);

export function buildWelcomeLines(input: {
  session: AgentSession;
  width: number;
  connection: string;
  version?: string;
}) {
  const width = Math.max(1, Math.floor(input.width));
  const actor = input.session.actor?.label?.trim() || 'PinPawo';
  const model = input.session.runtime?.model?.trim() || 'model loading';
  const cwd = input.session.runtime?.cwd?.trim() || 'workspace loading';
  const version = input.version ?? TUI_VERSION;
  const shortcuts = width >= 54
    ? ['/ commands · /resume sessions · Ctrl+Enter send', 'Esc interrupt · Ctrl+C exit']
    : ['/ commands · /resume sessions', 'Ctrl+Enter send · Esc interrupt', 'Ctrl+C exit'];
  return [
    ...PAW_LINES,
    `PinPawo TUI v2 · v${version} · ${actor}`,
    `${input.connection} · ${model}`,
    cwd,
    ...shortcuts,
    '',
  ].map((line) => truncateTerminalLine(line, width));
}
