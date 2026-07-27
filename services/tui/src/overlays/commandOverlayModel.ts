import stringWidth from 'string-width';
import {
  listTuiCommands,
  type TuiCommandDefinition,
} from '../commands/commandRegistry';
import { truncateTerminalLine } from '../text/terminalText';

export type CommandOverlayState =
  | { phase: 'closed' }
  | {
      phase: 'palette';
      query: string;
      selectedIndex: number;
      items: TuiCommandDefinition[];
    }
  | {
      phase: 'help';
      offset: number;
    };

export type CommandOverlayAction =
  | 'previous'
  | 'next'
  | 'page-up'
  | 'page-down'
  | 'complete'
  | 'submit'
  | 'close'
  | null;

export type CommandOverlayKey = {
  name: string;
  ctrl: boolean;
  shift: boolean;
};

export type CommandOverlayViewModel = {
  title: string;
  bottomTitle: string;
  content: string;
};

const OVERLAY_CONTENT_ROWS = 6;

export function createCommandOverlayState(): CommandOverlayState {
  return { phase: 'closed' };
}

export function syncCommandPalette(
  state: CommandOverlayState,
  input: {
    text: string;
    cursorOffset: number;
    enabled: boolean;
  },
): CommandOverlayState {
  if (state.phase === 'help') return state;
  const query = input.enabled
    ? commandPaletteQuery(input.text, input.cursorOffset)
    : null;
  if (query === null) {
    return state.phase === 'closed' ? state : createCommandOverlayState();
  }
  if (state.phase === 'palette' && state.query === query) return state;
  const items = matchingCommands(query);
  const selectedIndex = state.phase === 'palette'
    ? clampIndex(state.selectedIndex, items.length)
    : 0;
  return {
    phase: 'palette',
    query,
    selectedIndex,
    items,
  };
}

export function openCommandHelp(): CommandOverlayState {
  return { phase: 'help', offset: 0 };
}

export function closeCommandOverlay(): CommandOverlayState {
  return createCommandOverlayState();
}

export function moveCommandSelection(
  state: CommandOverlayState,
  delta: -1 | 1,
): CommandOverlayState {
  if (state.phase !== 'palette' || state.items.length === 0) return state;
  return {
    ...state,
    selectedIndex: clampIndex(state.selectedIndex + delta, state.items.length),
  };
}

export function pageCommandHelp(
  state: CommandOverlayState,
  direction: -1 | 1,
): CommandOverlayState {
  if (state.phase !== 'help') return state;
  const maximum = Math.max(0, helpLines().length - OVERLAY_CONTENT_ROWS);
  return {
    ...state,
    offset: Math.max(
      0,
      Math.min(maximum, state.offset + direction * OVERLAY_CONTENT_ROWS),
    ),
  };
}

export function selectedCommand(state: CommandOverlayState) {
  return state.phase === 'palette'
    ? state.items[state.selectedIndex] ?? null
    : null;
}

export function commandCompletion(state: CommandOverlayState) {
  const command = selectedCommand(state);
  if (!command) return null;
  return command.usage.includes('[')
    ? `/${command.name} `
    : `/${command.name}`;
}

export function resolveCommandOverlayKey(
  state: CommandOverlayState,
  key: CommandOverlayKey,
): CommandOverlayAction {
  if (state.phase === 'closed' || (key.ctrl && key.name === 'c')) return null;
  if (state.phase === 'help') {
    if (key.name === 'escape' || key.name.toLowerCase() === 'q') return 'close';
    if (key.name === 'pageup' || key.name === 'up') return 'page-up';
    if (key.name === 'pagedown' || key.name === 'down') return 'page-down';
    return null;
  }
  if (key.name === 'escape') return 'close';
  if (key.name === 'up') return 'previous';
  if (key.name === 'down') return 'next';
  if (key.name === 'tab') return 'complete';
  if (key.name === 'return') return 'submit';
  return null;
}

export function buildCommandOverlayViewModel(
  state: Exclude<CommandOverlayState, { phase: 'closed' }>,
  width: number,
): CommandOverlayViewModel {
  const innerWidth = Math.max(1, width - 4);
  if (state.phase === 'palette') {
    const visible = visiblePaletteItems(state);
    return {
      title: ` ${truncateTerminalLine(
        state.query ? `Commands · /${state.query}` : 'Commands',
        innerWidth,
      )} `,
      bottomTitle: ' Type to filter · ↑↓ · Tab complete · Enter · Esc ',
      content: visible.length
        ? visible.map(({ command, selected }) => formatCommandLine(
            command,
            selected,
            innerWidth,
          )).join('\n')
        : truncateTerminalLine('  No matching commands', innerWidth),
    };
  }

  const lines = helpLines();
  const maximum = Math.max(0, lines.length - OVERLAY_CONTENT_ROWS);
  const offset = Math.min(state.offset, maximum);
  const progress = lines.length > OVERLAY_CONTENT_ROWS
    ? ` · ${offset + 1}-${Math.min(offset + OVERLAY_CONTENT_ROWS, lines.length)}/${lines.length}`
    : '';
  return {
    title: ` ${truncateTerminalLine(`Help${progress}`, innerWidth)} `,
    bottomTitle: ' ↑↓ PgUp/PgDn · Esc/q close ',
    content: lines
      .slice(offset, offset + OVERLAY_CONTENT_ROWS)
      .map((line) => truncateTerminalLine(line, innerWidth))
      .join('\n'),
  };
}

function commandPaletteQuery(text: string, cursorOffset: number) {
  if (cursorOffset !== text.length || !text.startsWith('/') || /\s/.test(text)) {
    return null;
  }
  const query = text.slice(1);
  return /^[A-Za-z0-9_-]*$/.test(query) ? query.toLowerCase() : null;
}

function matchingCommands(query: string) {
  return listTuiCommands().filter((command) => (
    !query
    || command.name.startsWith(query)
    || command.aliases?.some((alias) => (
      alias.replace(/^\//, '').startsWith(query)
    ))
  ));
}

function visiblePaletteItems(
  state: Extract<CommandOverlayState, { phase: 'palette' }>,
) {
  const start = Math.min(
    Math.max(0, state.selectedIndex - OVERLAY_CONTENT_ROWS + 1),
    Math.max(0, state.items.length - OVERLAY_CONTENT_ROWS),
  );
  return state.items
    .slice(start, start + OVERLAY_CONTENT_ROWS)
    .map((command, index) => ({
      command,
      selected: start + index === state.selectedIndex,
    }));
}

function formatCommandLine(
  command: TuiCommandDefinition,
  selected: boolean,
  width: number,
) {
  const prefix = selected ? '› ' : '  ';
  const usage = command.usage;
  const description = ` — ${command.description}`;
  const usageWidth = stringWidth(prefix) + stringWidth(usage);
  const suffix = width - usageWidth >= 8 ? description : '';
  return truncateTerminalLine(`${prefix}${usage}${suffix}`, width);
}

function helpLines() {
  return [
    ...listTuiCommands().map((command) => (
      `  ${command.usage} — ${command.description}`
    )),
    '  Ctrl+R — Resume a session',
    '  Ctrl+Enter — Send the composer',
    '  Shift+Enter — Insert a newline in review responses',
    '  PgUp/PgDn — Browse timeline or active overlay',
  ];
}

function clampIndex(index: number, count: number) {
  if (count <= 0) return 0;
  return Math.max(0, Math.min(count - 1, index));
}
