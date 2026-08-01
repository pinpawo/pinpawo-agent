import type { AgentSession } from '@pinpawo/agent-session';
import stringWidth from 'string-width';
import type { LocalHostMetadata } from '../client/localHostMetadata';
import { sessionActorLabel } from '../session/sessionDisplay';
import { formatRuntimeModel } from '../status/statusModel';
import { truncateTerminalLine } from '../text/terminalText';
import { TUI_VERSION } from '../version';

const PAW_LINES = [
  '       ████   ████       ',
  '      ██████ ██████      ',
  '  ████ ████   ████ ████  ',
  ' ██████           ██████ ',
  '  ████   ███████   ████  ',
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
  const bordered = width >= 6;
  const contentWidth = bordered ? width - 4 : width;
  const actor = sessionActorLabel(input.session);
  const model = formatRuntimeModel(input.session) || 'model loading';
  const cwd = input.session.runtime?.cwd?.trim() || 'workspace loading';
  const version = input.version ?? TUI_VERSION;
  const localAgentVersion = formatVersion(
    input.hostMetadata?.localAgentVersion,
  );
  const capabilities = input.hostMetadata?.capabilities.length
    ? input.hostMetadata.capabilities
    : ['unavailable'];
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
  const detailWidth = sideBySide
    ? Math.max(1, contentWidth - terminalBlockWidth(PAW_LINES) - 4)
    : contentWidth;
  const details = [
    `PinPawo TUI v2 · ${actor}`,
    `v${version} · local-agent ${localAgentVersion}`,
    input.connection,
    '',
    `model         ${model}`,
    `directory     ${cwd}`,
    ...wrapCapabilityLines(capabilities, detailWidth, sideBySide ? 3 : 4),
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
  if (!bordered) return content;
  return [
    `╭${'─'.repeat(width - 2)}╮`,
    ...content.map((line) => `│ ${padTerminalLine(line, contentWidth)} │`),
    `╰${'─'.repeat(width - 2)}╯`,
    '',
  ];
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
