export type TuiCommandName =
  | 'help'
  | 'new'
  | 'studio'
  | 'chat'
  | 'policy'
  | 'export'
  | 'edit'
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
      args: string;
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
  name: 'studio',
  usage: '/studio [task]',
  description: 'Enter Studio mode or run a Studio task',
}, {
  name: 'chat',
  usage: '/chat',
  description: 'Return to chat mode',
}, {
  name: 'policy',
  usage: '/policy',
  description: 'Choose the global review policy',
}, {
  name: 'export',
  usage: '/export [path]',
  description: 'Export this session transcript as Markdown',
}, {
  name: 'edit',
  usage: '/edit [text]',
  description: 'Edit a composer draft with VISUAL or EDITOR',
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

const COMMAND_LIKE_RE = /^\/([A-Za-z][A-Za-z0-9_-]*)(?:\s+(.*))?$/;

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
  const args = (match[2] ?? '').trim();
  const command = COMMAND_BY_NAME.get(name);
  return command
    ? commandResult(command, raw, args)
    : { type: 'unknown', raw, name };
}

function commandResult(
  command: TuiCommandDefinition,
  raw: string,
  args = '',
): ParsedTuiCommand {
  return {
    type: 'command',
    command,
    name: command.name,
    raw,
    args,
  };
}
