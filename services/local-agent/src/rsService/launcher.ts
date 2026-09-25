import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { open } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { type RSContractRef, RSServiceConnection } from './connection';
import { ensureToken, readToken, type RSServicePaths } from './paths';
import { endpointIsLive } from './serve';
import type { RSServiceStatus } from './server';
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
 * Identity of the service code in one entry file.
 *
 * The built entry bundles every module the service runs, so a rebuild or an
 * upgrade changes it. From a source checkout only the entry file itself is
 * hashed, which does not track its imports.
 */
export function rsServiceBuildId(entryFile: string): string {
  return createHash('sha256').update(readFileSync(entryFile)).digest('hex').slice(0, 16);
}

/**
 * The service entry: the bundled `rsService.js` next to the built Host, or
 * the TypeScript source through tsx when running from a checkout.
 */
function resolveServiceEntry(): { args: readonly string[]; file: string } {
  const built = fileURLToPath(new URL('./rsService.js', import.meta.url));
  if (existsSync(built)) return { args: [built], file: built };
  const source = fileURLToPath(new URL('../rsServiceEntry.ts', import.meta.url));
  return { args: ['--import', import.meta.resolve('tsx/esm'), source], file: source };
}

/** The build a service started by this Host would run. */
export function currentRSServiceBuild(): string {
  return rsServiceBuildId(resolveServiceEntry().file);
}

const warnedStaleBuilds = new Set<string>();

/**
 * Stop a service running other code, but only while stopping ends nothing:
 * no running processes and no unanswered calls. Returns whether it stopped.
 */
async function stopIdleService(paths: RSServicePaths, token: string): Promise<boolean> {
  const admin = await RSServiceConnection.open({ paths, token });
  try {
    const status = await admin.admin('status') as RSServiceStatus;
    if (status.busy) return false;
    await admin.admin('stop');
  } finally {
    await admin.close();
  }
  const deadline = Date.now() + 5_000;
  while (await endpointIsLive(paths)) {
    if (Date.now() > deadline) {
      throw new RSServiceError('stop_timeout', 'The previous RS service did not stop in time.');
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
  }
  return true;
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
 * failed or another candidate won.
 *
 * A running service built from other code (after an upgrade or a rebuild) is
 * replaced when that ends nothing; while it still has running work it is kept
 * — the contract check already guarantees it speaks this Host's contract —
 * and a warning says how to restart it.
 */
export async function ensureRSService(options: Readonly<{
  paths: RSServicePaths;
  rs?: RSContractRef;
  startupTimeoutMs?: number;
  /** Test seam: how to run the service entry. */
  entryArgs?: readonly string[];
  /** Test seam: the build this Host expects the service to run. */
  expectedBuild?: string;
  warn?: (message: string) => void;
}>): Promise<RSServiceConnection> {
  const { paths } = options;
  const token = await ensureToken(paths);
  const entry = options.entryArgs ? null : resolveServiceEntry();
  const expectedBuild = options.expectedBuild ?? (entry ? rsServiceBuildId(entry.file) : null);
  const warn = options.warn ?? ((message: string) => console.warn(message));
  const openConnection = () => RSServiceConnection.open({
    paths,
    token,
    ...(options.rs ? { rs: options.rs } : {}),
  });
  try {
    const connection = await openConnection();
    const build = connection.serviceBuild;
    if (!expectedBuild || !build || build === expectedBuild) return connection;
    await connection.close();
    if (!await stopIdleService(paths, token)) {
      if (!warnedStaleBuilds.has(build)) {
        warnedStaleBuilds.add(build);
        warn(
          `[rs] The running RS service (build ${build}) differs from this Host (build ${expectedBuild}) `
          + 'and still has running work, so it is kept. Run `pinpawo rs stop` once that work is done.',
        );
      }
      return await openConnection();
    }
  } catch (error) {
    if (!isNotRunning(error)) throw error;
  }

  const entryArgs = options.entryArgs ?? entry!.args;
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
