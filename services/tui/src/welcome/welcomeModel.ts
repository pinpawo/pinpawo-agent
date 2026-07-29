import type { AgentSession } from '@pinpawo/agent-session';
import { sessionActorLabel } from '../session/sessionDisplay';
import { formatRuntimeModel } from '../status/statusModel';
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
  const actor = sessionActorLabel(input.session);
  const model = formatRuntimeModel(input.session) || 'model loading';
  const cwd = input.session.runtime?.cwd?.trim() || 'workspace loading';
  const version = input.version ?? TUI_VERSION;
  const shortcuts = width >= 54
    ? [
        '/ commands · PgUp history · Ctrl+Enter send',
        'Ctrl+R sessions · Esc interrupt · Ctrl+C exit',
      ]
    : [
        '/ commands · PgUp history',
        'Ctrl+R sessions',
        'Ctrl+Enter send · Esc interrupt',
        'Ctrl+C exit',
      ];
  return [
    ...PAW_LINES,
    `PinPawo TUI v2 · v${version} · ${actor}`,
    `${input.connection} · ${model}`,
    cwd,
    ...shortcuts,
    '',
  ].map((line) => truncateTerminalLine(line, width));
}
