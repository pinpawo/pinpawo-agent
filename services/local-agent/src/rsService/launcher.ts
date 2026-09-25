import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { open } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { type RSContractRef, RSServiceConnection } from './connection';
import { ensureToken, readToken, type RSServicePaths } from './paths';
import { RSServiceError } from './transport';

const DEFAULT_STARTUP_TIMEOUT_MS = 10_000;

/**
 * Variables the service process itself starts with.
 *
 * Commands do not run in this environment: every call carries the calling
 * Host's environment. Keeping the service's own environment minimal is what
 * stops one Host's variables from reaching another Host's commands.
 */
export function rsServiceBootstrapEnvironment(
  source: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of ['HOME', 'USER', 'LOGNAME', 'TMPDIR', 'LANG', 'LC_ALL', 'LC_CTYPE', 'PINPAWO_RS_DIR']) {
    if (source[key] !== undefined) env[key] = source[key];
  }
  env.PATH = '/usr/bin:/bin:/usr/sbin:/sbin';
  return env;
}

/**
 * The service entry: the bundled `rsService.js` next to the built Host, or
 * the TypeScript source through tsx when running from a checkout.
 */
function resolveServiceEntry(): { args: readonly string[] } {
  const built = fileURLToPath(new URL('./rsService.js', import.meta.url));
  if (existsSync(built)) return { args: [built] };
  const source = fileURLToPath(new URL('../rsServiceEntry.ts', import.meta.url));
  return { args: ['--import', import.meta.resolve('tsx/esm'), source] };
}

function isNotRunning(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return code === 'ENOENT' || code === 'ECONNREFUSED';
}

/** Connect to a running service without starting one (management commands). */
export async function connectRSService(options: Readonly<{
  paths: RSServicePaths;
  rs?: RSContractRef;
}>): Promise<RSServiceConnection | null> {
  let token: string;
  try {
    token = await readToken(options.paths);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  try {
    return await RSServiceConnection.open({ paths: options.paths, token, ...(options.rs ? { rs: options.rs } : {}) });
  } catch (error) {
    if (isNotRunning(error)) return null;
    throw error;
  }
}

/**
 * Connect to the service, starting it first when none is running.
 *
 * Concurrent callers may each start a candidate; candidates settle on one
 * owner among themselves, and every caller ends up connected to it. A caller
 * only ever terminates the candidate it started itself, and only when startup
 * failed.
 */
export async function ensureRSService(options: Readonly<{
  paths: RSServicePaths;
  rs?: RSContractRef;
  startupTimeoutMs?: number;
  /** Test seam: how to run the service entry. */
  entryArgs?: readonly string[];
}>): Promise<RSServiceConnection> {
  const { paths } = options;
  const token = await ensureToken(paths);
  const openConnection = () => RSServiceConnection.open({
    paths,
    token,
    ...(options.rs ? { rs: options.rs } : {}),
  });
  try {
    return await openConnection();
  } catch (error) {
    if (!isNotRunning(error)) throw error;
  }

  const entryArgs = options.entryArgs ?? resolveServiceEntry().args;
  const log = await open(paths.log, 'a', 0o600);
  let launchError: Error | undefined;
  let exited = false;
  const child = (() => {
    try {
      return spawn(process.execPath, [...entryArgs, '--root', paths.root], {
        detached: true,
        stdio: ['ignore', log.fd, log.fd],
        env: rsServiceBootstrapEnvironment(),
        cwd: paths.root,
      });
    } finally {
      void log.close();
    }
  })();
  child.once('error', (error) => { launchError = error; });
  child.once('exit', () => { exited = true; });
  child.unref();

  // Never leave a candidate behind that could start serving later: after a
  // failed startup, or once another launcher's candidate became the owner.
  const discardCandidate = () => {
    if (exited || !child.pid) return;
    try { child.kill('SIGKILL'); } catch { /* already gone */ }
  };
  const deadline = Date.now() + (options.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS);
  let lastError: unknown;
  while (Date.now() < deadline) {
    if (launchError) throw launchError;
    try {
      const connection = await openConnection();
      if (connection.servicePid !== child.pid) discardCandidate();
      return connection;
    } catch (error) {
      if (!isNotRunning(error)) throw error;
      lastError = error;
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
  }
  discardCandidate();
  throw new RSServiceError(
    'startup_failed',
    `RS service did not start (${lastError instanceof Error ? lastError.message : 'no response'}). `
    + `Inspect ${paths.log}.`,
  );
}
