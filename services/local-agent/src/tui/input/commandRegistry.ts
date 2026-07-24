export type TuiCommandName =
  | 'help'
  | 'quit'
  | 'chat'
  | 'studio'
  | 'new'
  | 'policy'
  | 'transcript'
  | 'export'
  | 'edit'
  | 'resume';

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
    name: 'policy',
    aliases: ['review-policy'],
    usage: '/policy',
    description: '选择全局访问策略',
    helpText: '/policy 选择授权策略',
  },
  {
    name: 'help',
    aliases: ['/'],
    usage: '/help',
    description: '显示帮助',
    helpText: '/help',
  },
  {
    name: 'transcript',
    aliases: ['history'],
    usage: '/transcript',
    description: '全屏浏览当前会话 transcript',
    helpText: '/transcript 浏览历史',
  },
  {
    name: 'export',
    usage: '/export [path]',
    description: '导出当前会话 transcript；默认写入启动目录，无扩展名 path 视为目录',
    helpText: '/export [path] 导出 transcript(默认当前目录)',
  },
  {
    name: 'edit',
    usage: '/edit [文本]',
    description: '使用 $VISUAL 或 $EDITOR 编辑草稿，保存后回填输入框',
    helpText: '/edit [文本] 外部编辑',
  },
  {
    name: 'resume',
    usage: '/resume',
    description: '打开可恢复会话选择器',
    helpText: '/resume 恢复会话',
  },
  {
    name: 'quit',
    aliases: ['exit'],
    usage: '/quit',
    description: '退出 TUI',
    helpText: '/quit',
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
    .map((command) => command.helpText)
    .join(' · ');
}

// A command name must look like /<word>(<space><args>)?
// — starting with an ASCII letter and continuing with letters/digits/_/-.
// Anything else (/ followed by a slash, digit, space, …) is treated as
// plain text so users can paste absolute paths like /Users/... or send a
// literal message starting with a slash without triggering "unknown
// command" feedback.
const COMMAND_LIKE_RE = /^\/([A-Za-z][A-Za-z0-9_-]*)(?:\s+(.*))?$/;

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

  const match = COMMAND_LIKE_RE.exec(raw);
  if (!match) {
    // Looks like a slash but not a command — e.g. /Users/foo, //comment,
    // /123. Fall through to chat so the message reaches the agent.
    return { type: 'text', text: raw };
  }

  const name = match[1];
  const args = (match[2] ?? '').trim();
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
