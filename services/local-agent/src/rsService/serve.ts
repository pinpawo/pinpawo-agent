import { lstat, mkdir, readFile, rm, stat, unlink, writeFile } from 'node:fs/promises';
import { connect } from 'node:net';
import { resolve } from 'node:path';
import {
  ensurePrivateRoot,
  readToken,
  type RSServicePaths,
  validateEndpoint,
} from './paths';
import { type RSServiceHandler, type RSServiceStopReport, startRSService } from './server';
import { RSServiceError } from './transport';

const STARTUP_LOCK_STALE_MS = 15_000;
const STARTUP_LOCK_DEADLINE_MS = 20_000;

/**
 * Hold the startup lock for the short window in which a candidate decides
 * whether it becomes the owner. Once a service listens, the live endpoint is
 * the proof of ownership; the lock only serializes candidates.
 */
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Whether a lock left by another candidate can be taken over. */
async function isStaleLock(paths: RSServicePaths): Promise<boolean> {
  try {
    const holder = Number((await readFile(resolve(paths.startupLock, 'pid'), 'utf8')).trim());
    // A candidate killed inside the window (a launcher discarding it) leaves
    // its lock behind; its pid tells us at once.
    if (Number.isInteger(holder) && holder > 0) return !isProcessAlive(holder);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  // No pid yet: the holder may be between creating the lock and recording it.
  const lock = await stat(paths.startupLock);
  return Date.now() - lock.mtimeMs > STARTUP_LOCK_STALE_MS;
}

async function acquireStartupLock(paths: RSServicePaths): Promise<() => Promise<void>> {
  const deadline = Date.now() + STARTUP_LOCK_DEADLINE_MS;
  while (Date.now() < deadline) {
    try {
      await mkdir(paths.startupLock, { mode: 0o700 });
      await writeFile(resolve(paths.startupLock, 'pid'), process.pid.toString(), { mode: 0o600 });
      return async () => {
        await rm(paths.startupLock, { recursive: true, force: true });
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    try {
      if (await isStaleLock(paths)) {
        await rm(paths.startupLock, { recursive: true, force: true });
        continue;
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      continue;
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
  }
  throw new RSServiceError('startup_locked', 'RS service ownership could not be established.');
}

/** Whether a service is already listening on the endpoint. Sends nothing. */
export async function endpointIsLive(paths: RSServicePaths): Promise<boolean> {
  try {
    await validateEndpoint(paths);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
  return await new Promise<boolean>((resolvePromise, reject) => {
    const socket = connect(paths.endpoint);
    socket.once('connect', () => {
      socket.destroy();
      resolvePromise(true);
    });
    socket.once('error', (error: NodeJS.ErrnoException) => {
      if (error.code === 'ECONNREFUSED' || error.code === 'ENOENT') resolvePromise(false);
      else reject(error);
    });
  });
}

async function removeStaleEndpoint(paths: RSServicePaths): Promise<void> {
  try {
    const endpoint = await lstat(paths.endpoint);
    const uid = typeof process.getuid === 'function' ? process.getuid() : undefined;
    if (!endpoint.isSocket() || (uid !== undefined && endpoint.uid !== uid)) {
      throw new RSServiceError(
        'invalid_endpoint',
        `Refusing to replace an RS endpoint not owned by this user: ${paths.endpoint}`,
      );
    }
    await unlink(paths.endpoint);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

export type ServeRSServiceResult =
  | Readonly<{ status: 'already_running' }>
  | Readonly<{ status: 'stopped'; report: RSServiceStopReport }>;

/**
 * Run the RS service in this process until it is stopped.
 *
 * Returns `already_running` without serving when another owner already
 * listens, which is how concurrent launches settle on one service.
 */
export async function serveRSService(options: Readonly<{
  paths: RSServicePaths;
  createHandlers: () => readonly RSServiceHandler[];
  build?: string;
  log?: (message: string) => void;
}>): Promise<ServeRSServiceResult> {
  const { paths } = options;
  await ensurePrivateRoot(paths);
  const token = await readToken(paths);
  const release = await acquireStartupLock(paths);
  let service: Awaited<ReturnType<typeof startRSService>>;
  try {
    if (await endpointIsLive(paths)) return { status: 'already_running' };
    await removeStaleEndpoint(paths);
    service = await startRSService({
      endpoint: paths.endpoint,
      token,
      handlers: options.createHandlers(),
      ...(options.build ? { build: options.build } : {}),
      ...(options.log ? { log: options.log } : {}),
    });
  } finally {
    await release();
  }
  const stop = () => { void service.stop(); };
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
  try {
    return { status: 'stopped', report: await service.stopped };
  } finally {
    process.off('SIGTERM', stop);
    process.off('SIGINT', stop);
  }
}
