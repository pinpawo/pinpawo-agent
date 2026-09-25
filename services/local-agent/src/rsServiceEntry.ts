/**
 * Entry of the standalone RS service process (#853).
 *
 * The launcher starts it detached with `--root <dir>`; it serves until a
 * management `stop` or a signal, then ends every session it holds. This file
 * is the composition root: it is the one place that names which RS contracts
 * the service provides.
 */
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { rsServiceBuildId } from './rsService/launcher';
import { resolveRSServicePaths } from './rsService/paths';
import { serveRSService } from './rsService/serve';
import { PosixShellRS } from './toolkits/local/posixShellRS';
import { prepareShellCommandDir } from './toolkits/local/shellCommandDir';
import { createShellRSServiceHandler } from './toolkits/local/shellRSService';

function readRoot(argv: readonly string[]): string | undefined {
  const index = argv.indexOf('--root');
  return index >= 0 ? argv[index + 1] : undefined;
}

try {
  const paths = resolveRSServicePaths(readRoot(process.argv));
  // Commands this RS provides ahead of the caller's PATH (the bundled rg).
  const commandDir = await prepareShellCommandDir(resolve(paths.root, 'bin'));
  const result = await serveRSService({
    paths,
    createHandlers: () => [createShellRSServiceHandler(new PosixShellRS({ commandDir }))],
    // Hosts compare this with the entry they would start to spot stale code.
    build: rsServiceBuildId(fileURLToPath(import.meta.url)),
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
