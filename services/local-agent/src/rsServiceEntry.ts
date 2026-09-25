/**
 * Entry of the standalone RS service process (#853).
 *
 * The launcher starts it detached with `--root <dir>`; it serves until a
 * management `stop` or a signal, then ends every session it holds. This file
 * is the composition root: it is the one place that names which RS contracts
 * the service provides.
 */
import { resolveRSServicePaths } from './rsService/paths';
import { serveRSService } from './rsService/serve';
import { createShellRSServiceHandler } from './toolkits/local/shellRSService';

function readRoot(argv: readonly string[]): string | undefined {
  const index = argv.indexOf('--root');
  return index >= 0 ? argv[index + 1] : undefined;
}

try {
  const result = await serveRSService({
    paths: resolveRSServicePaths(readRoot(process.argv)),
    createHandlers: () => [createShellRSServiceHandler()],
  });
  if (result.status === 'already_running') {
    process.stderr.write('[rs] another RS service already owns the endpoint; exiting.\n');
  }
  // Give the final replies (such as a stop report) a moment to flush, then
  // exit even if a stray handle would keep the process alive.
  setTimeout(() => process.exit(0), 100);
} catch (error) {
  process.stderr.write(`[rs] ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
