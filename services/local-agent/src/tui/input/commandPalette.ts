import {
  listTuiCommands,
  type TuiCommandDefinition,
} from './commandRegistry';

export type CommandPaletteModel =
  | {
      open: true;
      query: string;
      selectedIndex: number;
      items: TuiCommandDefinition[];
    }
  | {
      open: false;
      query: '';
      selectedIndex: 0;
      items: [];
    };

type CommandPaletteInput = {
  text: string;
  cursorOffset: number;
};

const CLOSED_COMMAND_PALETTE: CommandPaletteModel = {
  open: false,
  query: '',
  selectedIndex: 0,
  items: [],
};

export function buildCommandPaletteModel(
  input: CommandPaletteInput,
  selectedIndex = 0,
): CommandPaletteModel {
  const query = resolveCommandPaletteQuery(input);
  if (query === null) return CLOSED_COMMAND_PALETTE;

  const items = listTuiCommands()
    .filter((command) => commandMatchesQuery(command, query));
  return {
    open: true,
    query,
    selectedIndex: clampSelectedIndex(selectedIndex, items.length),
    items,
  };
}

export function moveCommandPaletteSelection(
  model: CommandPaletteModel,
  delta: -1 | 1,
): number {
  if (!model.open || model.items.length === 0) return 0;
  return clampSelectedIndex(model.selectedIndex + delta, model.items.length);
}

export function completeCommandPaletteInput(
  model: CommandPaletteModel,
): CommandPaletteInput | null {
  if (!model.open) return null;
  const command = model.items[model.selectedIndex];
  if (!command) return null;
  const completion = commandExpectsArgs(command) ? `/${command.name} ` : `/${command.name}`;
  return {
    text: completion,
    cursorOffset: completion.length,
  };
}

export function submitCommandPaletteInput(
  model: CommandPaletteModel,
): CommandPaletteInput | null {
  if (!model.open) return null;
  const command = model.items[model.selectedIndex];
  if (!command) return null;
  const text = `/${command.name}`;
  return {
    text,
    cursorOffset: text.length,
  };
}

function resolveCommandPaletteQuery(input: CommandPaletteInput): string | null {
  if (input.cursorOffset !== input.text.length) return null;
  if (!input.text.startsWith('/')) return null;
  if (/\s/.test(input.text)) return null;
  const query = input.text.slice(1);
  return /^[A-Za-z0-9_-]*$/.test(query) ? query.toLowerCase() : null;
}

function commandMatchesQuery(command: TuiCommandDefinition, query: string) {
  if (!query) return true;
  if (command.name.startsWith(query)) return true;
  return command.aliases?.some((alias) => alias.replace(/^\//, '').startsWith(query)) ?? false;
}

function clampSelectedIndex(index: number, itemCount: number) {
  if (itemCount <= 0) return 0;
  return Math.max(0, Math.min(itemCount - 1, index));
}

function commandExpectsArgs(command: TuiCommandDefinition) {
  return /(?:\[[^\]]+\]|<[^>]+>)/.test(command.usage);
}
