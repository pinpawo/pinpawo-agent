import {
  runStudioHostProcess,
  type StudioHostProcessOptions,
} from './studioHostProcess';
import { buildLocalAgentRuntimeConfig } from 'pinpawo/host-runtime';
import { createStudioCliPluginResolver } from './cliPluginLoader';

const HELP = `Usage: pinpawo-studio [options]

Start an independent resident PinPawo Studio Host.

Options:
  --workdir <directory>  workspace containing .pinpawo/studio.json
  --stdio                use newline-delimited JSON over stdio
  --port <port>          serve the loopback HTTP/WebSocket transport
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
    throw new Error('--port must be an integer from 1 to 65535.');
  }
  return port;
}

export type ParsedStudioHostCli =
  | { help: true }
  | { help: false; options: StudioHostProcessOptions };

export function parseStudioHostCliArgs(args: readonly string[]): ParsedStudioHostCli {
  let workdir: string | undefined;
  let stdio = false;
  let port: number | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '-h' || argument === '--help') return { help: true };
    if (argument === '--stdio') {
      stdio = true;
      continue;
    }
    if (argument === '--workdir') {
      workdir = readOptionValue(args, index, argument);
      index += 1;
      continue;
    }
    if (argument === '--port') {
      port = parsePort(readOptionValue(args, index, argument));
      index += 1;
      continue;
    }
    throw new Error(`Unknown option: ${argument}`);
  }
  if (stdio === (port !== undefined)) {
    throw new Error('Choose exactly one Studio transport: --stdio or --port <port>.');
  }
  return {
    help: false,
    options: {
      ...(workdir ? { workdir } : {}),
      transport: stdio
        ? { kind: 'stdio' }
        : { kind: 'websocket', port: port! },
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
  const runtimeConfig = buildLocalAgentRuntimeConfig(parsed.options.workdir);
  await (handlers.runHost ?? runStudioHostProcess)({
    ...parsed.options,
    resolvePlugin: createStudioCliPluginResolver({ workdir: runtimeConfig.workdir }),
  });
}
