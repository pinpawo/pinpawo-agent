import {
  runStudioHostProcess,
  type StudioHostProcessOptions,
} from './studioHostProcess';

const HELP = `Usage: pinpawo-studio [options]

Start an independent resident PinPawo Studio Host.

Options:
  --workdir <directory>  workspace containing .pinpawo/studio.json
  --pet-port <port>      resident Pet conversation listener (default: available port)
  -h, --help             display help
`;

export type StudioHostCliHandlers = {
  runHost?: (options: StudioHostProcessOptions) => Promise<void> | void;
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
  | { help: false; options: StudioHostProcessOptions };

export function parseStudioHostCliArgs(args: readonly string[]): ParsedStudioHostCli {
  let workdir: string | undefined;
  let agentSessionPort: number | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '-h' || argument === '--help') return { help: true };
    if (argument === '--workdir') {
      workdir = readOptionValue(args, index, argument);
      index += 1;
      continue;
    }
    if (argument === '--pet-port') {
      agentSessionPort = parsePort(readOptionValue(args, index, argument));
      index += 1;
      continue;
    }
    throw new Error(`Unknown option: ${argument}`);
  }
  return {
    help: false,
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
  await (handlers.runHost ?? runStudioHostProcess)(parsed.options);
}
