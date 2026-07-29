import type { AgentSession } from '@pinpawo/agent-session';
import stringWidth from 'string-width';
import type { LocalHostMetadata } from '../client/localHostMetadata';
import { sessionActorLabel } from '../session/sessionDisplay';
import { truncateTerminalLine } from '../text/terminalText';
import { TUI_VERSION } from '../version';

const PAW_LINES = [
  '       ███     ███       ',
  '      █████   █████      ',
  ' ███   ███     ███   ███ ',
  '█████               █████',
  ' ███                 ███ ',
  '         ███████         ',
  '       ███████████       ',
  '      █████████████      ',
  '      █████████████      ',
  '       ███████████       ',
  '         ███████         ',
] as const;

export const WELCOME_LOGO_HEIGHT = PAW_LINES.length;
export const WELCOME_LOGO_WIDTH = terminalBlockWidth(PAW_LINES);

export function buildWelcomeLines(input: {
  session: AgentSession;
  width: number;
  connection: string;
  version?: string;
  hostMetadata?: LocalHostMetadata | null;
}) {
  const width = Math.max(1, Math.floor(input.width));
  const actor = sessionActorLabel(input.session);
  const model = input.session.runtime?.model?.trim() || 'model loading';
  const cwd = input.session.runtime?.cwd?.trim() || 'workspace loading';
  const version = input.version ?? TUI_VERSION;
  const localAgentVersion = formatVersion(
    input.hostMetadata?.localAgentVersion,
  );
  const capabilities = input.hostMetadata?.capabilities.length
    ? input.hostMetadata.capabilities
    : ['unavailable'];
  const shortcuts = width >= 54
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
  const sideBySide = width >= 64;
  const detailWidth = sideBySide
    ? Math.max(1, width - terminalBlockWidth(PAW_LINES) - 4)
    : width;
  const details = [
    `PinPawo TUI v2 · ${actor}`,
    `tui v${version} · local-agent ${localAgentVersion}`,
    input.connection,
    `model         ${model}`,
    `directory     ${cwd}`,
    ...wrapCapabilityLines(capabilities, detailWidth, sideBySide ? 3 : 4),
  ];
  const identity = sideBySide
    ? joinTerminalColumns(PAW_LINES, details, width, 4)
    : [
        ...PAW_LINES,
        '',
        ...details,
      ];
  return [
    ...identity,
    '',
    ...shortcuts,
    '',
  ].map((line) => truncateTerminalLine(line, width));
}

function wrapCapabilityLines(
  capabilities: readonly string[],
  width: number,
  maxLines: number,
) {
  const label = 'capabilities  ';
  const continuation = ' '.repeat(label.length);
  const lines: string[] = [];
  let line = label;

  for (const capability of capabilities) {
    const token = `${line === label ? '' : ' · '}${capability}`;
    if (
      line !== label
      && stringWidth(line) + stringWidth(token) > width
      && lines.length < maxLines - 1
    ) {
      lines.push(line);
      line = `${continuation}${capability}`;
      continue;
    }
    line += token;
  }
  lines.push(line);
  return lines;
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
