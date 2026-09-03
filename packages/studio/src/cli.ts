import {
  runStudioHostProcess,
  type StudioHostProcessOptions,
} from './studioHostProcess';
import {
  initStudioWorkdir,
  type InitStudioWorkdirOptions,
} from './studioTemplate';
import {
  launchStudioTmux,
  openStudioConsole,
  type StudioConsoleOptions,
  type StudioTmuxOptions,
} from './studioCliLaunchers';

const HELP = `Usage: pinpawo-studio [start] [options]
       pinpawo-studio init [options]
       pinpawo-studio tmux [options]
       pinpawo-studio console [options]

Start an independent resident PinPawo Studio Host.

Options:
  --workdir <directory>  workspace containing .pinpawo/studio.json (start/init)
  --pet-port <port>      already-running resident Pet listener (required for tmux)
  --pet <id>             Pet TUI to include (repeatable; skips HTTP discovery)
  --studio-url <url>     running Studio HTTP origin for Pet discovery (default: 127.0.0.1:3211)
  --session <name>       tmux session name (default: pinpawo-studio)
  --detached             create the tmux session without attaching
  --reset                replace an existing tmux session with the same name
  --console              start the Studio Console if needed, then open it after tmux is ready
  --url <url>            Studio Console URL (default: http://127.0.0.1:5173)
  -h, --help             display help

Init creates the shipped Studio configuration, Pet Capabilities, and initial
Wiki files in the selected workdir without overwriting existing files.
Tmux connects to an existing Host and builds a tiled TUI for its Pets. Console
starts the separately served Studio Console Web when needed, then opens it in
the default browser.
`;

export type StudioHostCliHandlers = {
  runHost?: (options: StudioHostProcessOptions) => Promise<void> | void;
  initWorkdir?: (options: InitStudioWorkdirOptions) => Promise<{
    workdir: string;
    files: string[];
  }>;
  launchTmux?: (options: StudioTmuxOptions) => Promise<void> | void;
  openConsole?: (options: StudioConsoleOptions) => Promise<void> | void;
  writeOutput?: (text: string) => void;
};

function readOptionValue(args: readonly string[], index: number, option: string): string {
  const value = args[index + 1];
  if (!value || value.startsWith('-')) {
    throw new Error(`${option} requires a value.`);
  }
  return value;
}

function parsePort(value: string): number {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error('--pet-port must be an integer from 1 to 65535.');
  }
  return port;
}

export type ParsedStudioHostCli =
  | { help: true }
  | { help: false; command: 'start'; options: StudioHostProcessOptions }
  | { help: false; command: 'init'; options: InitStudioWorkdirOptions }
  | { help: false; command: 'tmux'; options: StudioTmuxOptions }
  | { help: false; command: 'console'; options: StudioConsoleOptions };

export function parseStudioHostCliArgs(args: readonly string[]): ParsedStudioHostCli {
  const knownCommand = args[0] === 'init' || args[0] === 'start'
    || args[0] === 'tmux' || args[0] === 'console';
  const command = knownCommand ? args[0] as 'init' | 'start' | 'tmux' | 'console' : 'start';
  const offset = knownCommand ? 1 : 0;
  let workdir: string | undefined;
  let agentSessionPort: number | undefined;
  let sessionName: string | undefined;
  let detached = false;
  let reset = false;
  let openConsole = false;
  let consoleUrl: string | undefined;
  let studioUrl: string | undefined;
  const petIds: string[] = [];
  for (let index = offset; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '-h' || argument === '--help') return { help: true };
    if (argument === '--workdir') {
      if (command === 'tmux' || command === 'console') {
        throw new Error(`--workdir is not valid for Studio ${command}.`);
      }
      workdir = readOptionValue(args, index, argument);
      index += 1;
      continue;
    }
    if (argument === '--pet-port') {
      if (command === 'init' || command === 'console') {
        throw new Error(`--pet-port is not valid for Studio ${command}.`);
      }
      agentSessionPort = parsePort(readOptionValue(args, index, argument));
      index += 1;
      continue;
    }
    if (argument === '--session') {
      if (command !== 'tmux') throw new Error('--session is only valid for Studio tmux.');
      sessionName = readOptionValue(args, index, argument);
      index += 1;
      continue;
    }
    if (argument === '--pet') {
      if (command !== 'tmux') throw new Error('--pet is only valid for Studio tmux.');
      petIds.push(readOptionValue(args, index, argument));
      index += 1;
      continue;
    }
    if (argument === '--studio-url') {
      if (command !== 'tmux') throw new Error('--studio-url is only valid for Studio tmux.');
      studioUrl = readOptionValue(args, index, argument);
      index += 1;
      continue;
    }
    if (argument === '--detached') {
      if (command !== 'tmux') throw new Error('--detached is only valid for Studio tmux.');
      detached = true;
      continue;
    }
    if (argument === '--reset') {
      if (command !== 'tmux') throw new Error('--reset is only valid for Studio tmux.');
      reset = true;
      continue;
    }
    if (argument === '--console') {
      if (command !== 'tmux') throw new Error('--console is only valid for Studio tmux.');
      openConsole = true;
      continue;
    }
    if (argument === '--url') {
      if (command !== 'tmux' && command !== 'console') {
        throw new Error('--url is only valid for Studio tmux or console.');
      }
      consoleUrl = readOptionValue(args, index, argument);
      index += 1;
      continue;
    }
    throw new Error(`Unknown option: ${argument}`);
  }
  if (command === 'init') {
    return {
      help: false,
      command,
      options: { workdir: workdir ?? process.cwd() },
    };
  }
  if (command === 'tmux') {
    if (agentSessionPort === undefined) {
      throw new Error('--pet-port is required for Studio tmux; read it from the running Host startup output.');
    }
    return {
      help: false,
      command,
      options: {
        agentSessionPort,
        ...(petIds.length > 0 ? { petIds } : {}),
        ...(studioUrl ? { studioUrl } : {}),
        ...(sessionName ? { sessionName } : {}),
        ...(detached ? { detached } : {}),
        ...(reset ? { reset } : {}),
        ...(openConsole ? { openConsole } : {}),
        ...(consoleUrl ? { consoleUrl } : {}),
      },
    };
  }
  if (command === 'console') {
    return {
      help: false,
      command,
      options: { ...(consoleUrl ? { url: consoleUrl } : {}) },
    };
  }
  return {
    help: false,
    command,
    options: {
      ...(workdir ? { workdir } : {}),
      ...(agentSessionPort !== undefined ? { agentSessionPort } : {}),
    },
  };
}

/** Run the Studio package's standalone CLI. */
export async function runStudioHostCli(
  argv = process.argv.slice(2),
  handlers: StudioHostCliHandlers = {},
): Promise<void> {
  const parsed = parseStudioHostCliArgs(argv);
  if (parsed.help) {
    (handlers.writeOutput ?? process.stdout.write.bind(process.stdout))(HELP);
    return;
  }
  if (parsed.command === 'init') {
    const result = await (handlers.initWorkdir ?? initStudioWorkdir)(parsed.options);
    (handlers.writeOutput ?? process.stdout.write.bind(process.stdout))(
      `Initialized Studio workdir in ${result.workdir} (${result.files.length.toString()} files).\n`,
    );
    return;
  }
  if (parsed.command === 'tmux') {
    await (handlers.launchTmux ?? launchStudioTmux)(parsed.options);
    return;
  }
  if (parsed.command === 'console') {
    await (handlers.openConsole ?? openStudioConsole)(parsed.options);
    return;
  }
  await (handlers.runHost ?? runStudioHostProcess)(parsed.options);
}
