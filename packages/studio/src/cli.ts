import {
  runStudioHostProcess,
  type StudioHostProcessOptions,
} from './studioHostProcess';
import {
  initStudioKickstart,
  type InitStudioKickstartOptions,
} from './studioTemplate';

const HELP = `Usage: pinpawo-studio [start] [options]
       pinpawo-studio init [options]

Start an independent resident PinPawo Studio Host.

Options:
  --workdir <directory>  workspace containing .pinpawo/studio.json
  --pet-port <port>      resident Pet conversation listener (default: available port)
  -h, --help             display help

Init copies the shipped kickstart Pet, Capability, Plugin, and Wiki files into
the workdir without overwriting existing files.
`;

export type StudioHostCliHandlers = {
  runHost?: (options: StudioHostProcessOptions) => Promise<void> | void;
  initKickstart?: (options: InitStudioKickstartOptions) => Promise<{
    workdir: string;
    files: string[];
  }>;
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
  | { help: false; command: 'init'; options: InitStudioKickstartOptions };

export function parseStudioHostCliArgs(args: readonly string[]): ParsedStudioHostCli {
  const command = args[0] === 'init' ? 'init' : 'start';
  const offset = args[0] === 'init' || args[0] === 'start' ? 1 : 0;
  let workdir: string | undefined;
  let agentSessionPort: number | undefined;
  for (let index = offset; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '-h' || argument === '--help') return { help: true };
    if (argument === '--workdir') {
      workdir = readOptionValue(args, index, argument);
      index += 1;
      continue;
    }
    if (argument === '--pet-port') {
      if (command === 'init') throw new Error('--pet-port is not valid for Studio init.');
      agentSessionPort = parsePort(readOptionValue(args, index, argument));
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
    const result = await (handlers.initKickstart ?? initStudioKickstart)(parsed.options);
    (handlers.writeOutput ?? process.stdout.write.bind(process.stdout))(
      `Initialized Studio kickstart in ${result.workdir} (${result.files.length.toString()} files).\n`,
    );
    return;
  }
  await (handlers.runHost ?? runStudioHostProcess)(parsed.options);
}
