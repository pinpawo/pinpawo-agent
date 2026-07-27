export type TuiCommandName =
  | 'help'
  | 'new'
  | 'resume'
  | 'quit';

export type TuiCommandDefinition = {
  name: TuiCommandName;
  aliases?: string[];
  usage: string;
  description: string;
};

export type ParsedTuiCommand =
  | { type: 'empty' }
  | { type: 'text'; text: string }
  | {
      type: 'command';
      command: TuiCommandDefinition;
      name: TuiCommandName;
      raw: string;
    }
  | {
      type: 'unknown';
      raw: string;
      name: string;
    };

const COMMANDS: readonly TuiCommandDefinition[] = [{
  name: 'help',
  aliases: ['/'],
  usage: '/help',
  description: 'Show commands and keyboard shortcuts',
}, {
  name: 'new',
  usage: '/new',
  description: 'Start a new chat session',
}, {
  name: 'resume',
  usage: '/resume',
  description: 'Choose a previous session',
}, {
  name: 'quit',
  aliases: ['exit'],
  usage: '/quit',
  description: 'Exit the TUI',
}];

const COMMAND_BY_NAME = new Map<string, TuiCommandDefinition>();
for (const command of COMMANDS) {
  COMMAND_BY_NAME.set(command.name, command);
  for (const alias of command.aliases ?? []) {
    COMMAND_BY_NAME.set(alias.replace(/^\//, ''), command);
  }
}

const COMMAND_LIKE_RE = /^\/([A-Za-z][A-Za-z0-9_-]*)$/;

export function listTuiCommands() {
  return [...COMMANDS];
}

export function parseTuiCommand(input: string): ParsedTuiCommand {
  const raw = input.trim();
  if (!raw) return { type: 'empty' };
  if (raw === '/') {
    return commandResult(COMMAND_BY_NAME.get('help')!, raw);
  }
  if (!raw.startsWith('/')) {
    return { type: 'text', text: input };
  }

  const match = COMMAND_LIKE_RE.exec(raw);
  if (!match) {
    return { type: 'text', text: input };
  }
  const name = match[1].toLowerCase();
  const command = COMMAND_BY_NAME.get(name);
  return command
    ? commandResult(command, raw)
    : { type: 'unknown', raw, name };
}

function commandResult(
  command: TuiCommandDefinition,
  raw: string,
): ParsedTuiCommand {
  return {
    type: 'command',
    command,
    name: command.name,
    raw,
  };
}
