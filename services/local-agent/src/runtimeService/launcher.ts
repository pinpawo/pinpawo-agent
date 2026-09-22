import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, open, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { RuntimeClient } from './client';
import { runtimeServicePaths } from './config';
import { RuntimeServiceError } from './protocol';

async function serviceToken(directory?: string): Promise<string> {
  const paths = runtimeServicePaths(directory);
  await mkdir(paths.root, { recursive: true, mode: 0o700 });
  try {
    const file = await open(paths.token, 'wx', 0o600);
    try { await file.writeFile(randomBytes(32).toString('hex')); }
    finally { await file.close(); }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  // Another launcher may have just created the file and still be writing it.
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const token = (await readFile(paths.token, 'utf8')).trim();
    if (/^[0-9a-f]{64}$/.test(token)) return token;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new RuntimeServiceError('invalid_token', 'Runtime credential file is invalid.');
}

export async function connectRuntimeService(options: {
  directory?: string;
  toolkits?: Readonly<Record<string, string>>;
  administrative?: boolean;
} = {}): Promise<RuntimeClient> {
  const paths = runtimeServicePaths(options.directory);
  const token = (await readFile(paths.token, 'utf8')).trim();
  return RuntimeClient.connect({
    endpoint: paths.endpoint, token, toolkits: options.toolkits ?? {},
    administrative: options.administrative,
  });
}

function isMissingService(error: unknown): boolean {
  return ['ENOENT', 'ECONNREFUSED'].includes(String((error as NodeJS.ErrnoException).code));
}

export async function ensureRuntimeService(options: {
  directory?: string;
  toolkits?: Readonly<Record<string, string>>;
  administrative?: boolean;
  bootstrapEnv?: NodeJS.ProcessEnv;
} = {}): Promise<RuntimeClient> {
  const paths = runtimeServicePaths(options.directory);
  const token = await serviceToken(paths.root);
  const connect = () => RuntimeClient.connect({
    endpoint: paths.endpoint, token, toolkits: options.toolkits ?? {},
    administrative: options.administrative,
  });
  try { return await connect(); }
  catch (error) { if (!isMissingService(error)) throw error; }

  const builtEntry = fileURLToPath(new URL('./runtimeService.js', import.meta.url));
  const sourceEntry = fileURLToPath(new URL('./entry.ts', import.meta.url));
  const args = existsSync(builtEntry)
    ? [builtEntry, '--directory', paths.root]
    : ['--import', import.meta.resolve('tsx/esm'), sourceEntry, '--directory', paths.root];
  const log = await open(paths.log, 'a', 0o600);
  let launchError: Error | undefined;
  try {
    const child = spawn(process.execPath, args, {
      detached: true,
      stdio: ['ignore', log.fd, log.fd],
      env: { ...(options.bootstrapEnv ?? process.env) },
      cwd: paths.root,
    });
    child.once('error', (error) => { launchError = error; });
    child.unref();
  } finally { await log.close(); }

  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (launchError) throw launchError;
    try { return await connect(); }
    catch (error) { if (!isMissingService(error)) throw error; }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new RuntimeServiceError('startup_failed', `Runtime service did not start. Inspect ${paths.log}.`);
}
