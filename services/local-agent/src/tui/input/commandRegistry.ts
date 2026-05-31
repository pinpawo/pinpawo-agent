export type TuiCommandName =
  | 'help'
  | 'quit'
  | 'chat'
  | 'studio'
  | 'new'
  | 'allow'
  | 'export';

export type TuiCommandDefinition = {
  name: TuiCommandName;
  aliases?: string[];
  usage: string;
  description: string;
  helpText: string;
};

export type ParsedTuiCommand =
  | {
      type: 'empty';
    }
  | {
      type: 'text';
      text: string;
    }
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
      args: string;
    };

const COMMANDS: TuiCommandDefinition[] = [
  {
    name: 'new',
    usage: '/new',
    description: '创建新会话',
    helpText: '/new 新会话',
  },
  {
    name: 'studio',
    usage: '/studio [任务]',
    description: '进入 Studio 模式或提交 Studio 任务',
    helpText: '/studio [任务] 进入 Studio 模式',
  },
  {
    name: 'chat',
    usage: '/chat',
    description: '退出 Studio 模式',
    helpText: '/chat 退出 Studio',
  },
  {
    name: 'help',
    aliases: ['/'],
    usage: '/help',
    description: '显示帮助',
    helpText: '/help',
  },
  {
    name: 'export',
    usage: '/export [path]',
    description: '导出当前会话 transcript',
    helpText: '/export 导出 transcript',
  },
  {
    name: 'quit',
    aliases: ['exit'],
    usage: '/quit',
    description: '退出 TUI',
    helpText: '/quit',
  },
  {
    name: 'allow',
    usage: '/allow',
    description: '提交当前 human review 授权',
    helpText: '/allow',
  },
];

const COMMAND_BY_NAME = new Map<string, TuiCommandDefinition>();
for (const command of COMMANDS) {
  COMMAND_BY_NAME.set(command.name, command);
  for (const alias of command.aliases ?? []) {
    COMMAND_BY_NAME.set(alias.replace(/^\//, ''), command);
  }
}

export function listTuiCommands() {
  return [...COMMANDS];
}

export function formatTuiCommandHelp() {
  return COMMANDS
    .filter((command) => command.name !== 'allow')
    .map((command) => command.helpText)
    .join(' · ');
}

export function parseTuiCommand(input: string): ParsedTuiCommand {
  const raw = input.trim();
  if (!raw) return { type: 'empty' };
  if (raw === '/') {
    const command = COMMAND_BY_NAME.get('help')!;
    return {
      type: 'command',
      command,
      name: command.name,
      raw,
      args: '',
    };
  }
  if (!raw.startsWith('/')) {
    return { type: 'text', text: raw };
  }

  const withoutSlash = raw.slice(1);
  const firstSpace = withoutSlash.search(/\s/);
  const name = firstSpace === -1 ? withoutSlash : withoutSlash.slice(0, firstSpace);
  const args = firstSpace === -1 ? '' : withoutSlash.slice(firstSpace).trim();
  const command = COMMAND_BY_NAME.get(name);

  if (!command) {
    return {
      type: 'unknown',
      raw,
      name,
      args,
    };
  }

  return {
    type: 'command',
    command,
    name: command.name,
    raw,
    args,
  };
}
