import type { AgentSession } from '@pinpawo/agent-session';
import stringWidth from 'string-width';
import type { LocalHostMetadata } from '../client/localHostMetadata';
import { sessionActorLabel } from '../session/sessionDisplay';
import { formatRuntimeModel } from '../status/statusModel';
import { truncateTerminalLine } from '../text/terminalText';
import { TUI_VERSION } from '../version';

/**
 * Pixel-art paw print. One square pixel is two columns wide because terminal
 * cells are twice as tall as they are wide, so every run starts on an even
 * column and spans an even width. Square corners only: half-block bevels read
 * as mush at this size.
 */
const PAW_LINES = [
  '  ██    ██  ',
  '██        ██',
  '            ',
  '  ████████  ',
  '████████████',
  '  ████████  ',
] as const;

export const WELCOME_LOGO_HEIGHT = PAW_LINES.length;
export const WELCOME_LOGO_WIDTH = terminalBlockWidth(PAW_LINES);

/**
 * The welcome block is separated from the transcript by a shared background
 * rather than a drawn border, so it reserves one blank row and two blank
 * columns on each side as the visual gutter.
 */
export const WELCOME_PAD_ROWS = 1;
export const WELCOME_PAD_COLUMNS = 2;

export function buildWelcomeLines(input: {
  session: AgentSession;
  width: number;
  connection: string;
  version?: string;
  hostMetadata?: LocalHostMetadata | null;
}) {
  const width = Math.max(1, Math.floor(input.width));
  const padded = width >= WELCOME_PAD_COLUMNS * 2 + 2;
  const contentWidth = padded ? width - WELCOME_PAD_COLUMNS * 2 : width;
  const actor = sessionActorLabel(input.session);
  const model = formatRuntimeModel(input.session) || 'model loading';
  const cwd = input.session.runtime?.cwd?.trim() || 'workspace loading';
  const version = input.version ?? TUI_VERSION;
  const localAgentVersion = formatVersion(
    input.hostMetadata?.localAgentVersion,
  );
  const shortcuts = contentWidth >= 54
    ? [
        '/ commands · PgUp history · Enter send',
        'Ctrl+J newline · Ctrl+R sessions · Esc interrupt · Ctrl+C exit',
      ]
    : [
        '/ commands · PgUp history',
        'Ctrl+R sessions',
        'Enter send · Ctrl+J newline',
        'Esc interrupt',
        'Ctrl+C exit',
  ];
  const sideBySide = contentWidth >= 64;
  const details = [
    `PinPawo TUI v2 · ${actor}`,
    `v${version} · local-agent ${localAgentVersion}`,
    input.connection,
    '',
    `model         ${model}`,
    `directory     ${cwd}`,
  ];
  const identity = sideBySide
    ? joinTerminalColumns(PAW_LINES, details, contentWidth, 4)
    : [
        ...PAW_LINES,
        '',
        ...details,
      ];
  const content = [
    ...identity,
    '',
    ...shortcuts,
    '',
  ].map((line) => truncateTerminalLine(line, contentWidth));
  if (!padded) return content;
  const gutter = ' '.repeat(WELCOME_PAD_COLUMNS);
  const blankRow = ' '.repeat(width);
  return [
    ...Array<string>(WELCOME_PAD_ROWS).fill(blankRow),
    ...content.map(
      (line) => `${gutter}${padTerminalLine(line, contentWidth)}${gutter}`,
    ),
    ...Array<string>(WELCOME_PAD_ROWS).fill(blankRow),
    '',
  ];
}

function joinTerminalColumns(
  left: readonly string[],
  right: readonly string[],
  width: number,
  gap: number,
) {
  const leftWidth = terminalBlockWidth(left);
  const rightOffset = Math.max(0, Math.floor((left.length - right.length) / 2));
  const rowCount = Math.max(left.length, rightOffset + right.length);
  return Array.from({ length: rowCount }, (_, index) => {
    const leftLine = left[index] ?? '';
    const rightLine = right[index - rightOffset] ?? '';
    if (!rightLine) return leftLine;
    return `${padTerminalLine(leftLine, leftWidth)}${' '.repeat(gap)}${rightLine}`;
  }).map((line) => truncateTerminalLine(line, width));
}

function terminalBlockWidth(lines: readonly string[]) {
  return lines.reduce(
    (maximum, line) => Math.max(maximum, stringWidth(line)),
    0,
  );
}

function padTerminalLine(value: string, width: number) {
  return `${value}${' '.repeat(Math.max(0, width - stringWidth(value)))}`;
}

function formatVersion(value: string | null | undefined) {
  const version = value?.trim();
  if (!version) return 'unknown';
  return version.startsWith('v') || !/^\d/.test(version)
    ? version
    : `v${version}`;
}
