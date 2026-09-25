import { randomBytes } from 'node:crypto';
import { lstat, mkdir, open, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { RSServiceError } from './transport';

/**
 * Where the RS service of one OS user lives. Every file sits in one private
 * directory, so ownership of that directory is the ownership check for all of
 * them.
 */
export type RSServicePaths = Readonly<{
  root: string;
  endpoint: string;
  token: string;
  /** Directory held only while a service decides whether it is the owner. */
  startupLock: string;
  log: string;
}>;

/** Unix socket paths are limited to about 104 bytes on macOS. */
const MAX_ENDPOINT_BYTES = 100;

export function resolveRSServicePaths(
  root = process.env.PINPAWO_RS_DIR ?? resolve(homedir(), '.pinpawo', 'rs'),
): RSServicePaths {
  const base = resolve(root);
  const endpoint = resolve(base, 'rs.sock');
  if (Buffer.byteLength(endpoint) > MAX_ENDPOINT_BYTES) {
    throw new RSServiceError(
      'invalid_endpoint',
      `RS service directory is too long for a local socket: ${base}`,
    );
  }
  return Object.freeze({
    root: base,
    endpoint,
    token: resolve(base, 'token'),
    startupLock: resolve(base, 'startup.lock'),
    log: resolve(base, 'service.log'),
  });
}

function currentUid(): number | undefined {
  return typeof process.getuid === 'function' ? process.getuid() : undefined;
}

/**
 * Create the service directory if needed and refuse one that is not private
 * to this user. An existing path is never repaired: it could belong to
 * another user or be a link.
 */
export async function ensurePrivateRoot(paths: RSServicePaths): Promise<void> {
  try {
    await mkdir(paths.root, { recursive: true, mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  const stat = await lstat(paths.root);
  const uid = currentUid();
  if (
    !stat.isDirectory()
    || (uid !== undefined && stat.uid !== uid)
    || (stat.mode & 0o077) !== 0
  ) {
    throw new RSServiceError(
      'invalid_endpoint',
      `RS service directory must be a private directory owned by the current user: ${paths.root}`,
    );
  }
}

/** Refuse to talk to anything but a socket this user owns. */
export async function validateEndpoint(paths: RSServicePaths): Promise<void> {
  const stat = await lstat(paths.endpoint);
  const uid = currentUid();
  if (!stat.isSocket() || (uid !== undefined && stat.uid !== uid)) {
    throw new RSServiceError(
      'invalid_endpoint',
      `RS endpoint must be a socket owned by the current user: ${paths.endpoint}`,
    );
  }
}

const TOKEN_PATTERN = /^[0-9a-f]{64}$/;

export async function readToken(paths: RSServicePaths): Promise<string> {
  const token = (await readFile(paths.token, 'utf8')).trim();
  if (!TOKEN_PATTERN.test(token)) {
    throw new RSServiceError('invalid_token', `RS credential file is invalid: ${paths.token}`);
  }
  return token;
}

/**
 * Read the service token, creating it on first use. The token is the only
 * permission boundary of the service; it never changes while its file exists.
 */
export async function ensureToken(paths: RSServicePaths): Promise<string> {
  await ensurePrivateRoot(paths);
  try {
    const file = await open(paths.token, 'wx', 0o600);
    try {
      await file.writeFile(randomBytes(32).toString('hex'));
    } finally {
      await file.close();
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  // Another launcher may have just created the file and still be writing it.
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      return await readToken(paths);
    } catch (error) {
      if (!(error instanceof RSServiceError)) throw error;
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));
    }
  }
  return await readToken(paths);
}
