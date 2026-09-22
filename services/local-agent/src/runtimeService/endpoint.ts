import { lstat, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { RuntimeServiceError } from './protocol';

async function validateDirectory(directory: string): Promise<void> {
  const stat = await lstat(directory);
  if (!stat.isDirectory() || stat.uid !== process.getuid!() || (stat.mode & 0o077) !== 0) {
    throw new RuntimeServiceError('invalid_endpoint', 'Runtime socket directory must be a private directory owned by the current user.');
  }
}

/** Keep the socket name inside a user-owned namespace, including before listen. */
export async function ensureRuntimeEndpointDirectory(endpoint: string): Promise<void> {
  if (process.platform === 'win32') return;
  const directory = dirname(endpoint);
  try { await mkdir(directory, { mode: 0o700 }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  // Never repair an existing path: it could belong to another user or be a link.
  await validateDirectory(directory);
}

/** Validate before connecting, so a rejected endpoint never receives a token. */
export async function validateRuntimeEndpoint(endpoint: string): Promise<void> {
  if (process.platform === 'win32') return;
  await validateDirectory(dirname(endpoint));
  const stat = await lstat(endpoint);
  if (!stat.isSocket() || stat.uid !== process.getuid!()) {
    throw new RuntimeServiceError('invalid_endpoint', 'Runtime endpoint must be a socket owned by the current user.');
  }
}
