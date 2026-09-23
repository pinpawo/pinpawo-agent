import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, open, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { RuntimeClient } from './client';
import { runtimeServicePaths } from './config';
import { ensureRuntimeEndpointDirectory } from './endpoint';
import { RuntimeServiceError } from './protocol';

/** The persistent service must not inherit a Host project's loaded .env secrets. */
export function runtimeServiceBootstrapEnvironment(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const allowed = process.platform === 'win32'
    ? ['SystemRoot', 'WINDIR', 'ComSpec', 'PATHEXT', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'TEMP', 'TMP', 'PATH']
    : ['HOME', 'USER', 'LOGNAME', 'TMPDIR', 'LANG', 'LC_ALL', 'LC_CTYPE', 'DISPLAY', 'WAYLAND_DISPLAY', 'XDG_RUNTIME_DIR', 'XAUTHORITY'];
  const env: NodeJS.ProcessEnv = {};
  for (const key of allowed) if (source[key] !== undefined) env[key] = source[key];
  if (process.platform !== 'win32') {
    env.PATH = '/opt/homebrew/bin:/usr/local/bin:/usr/local/sbin:/usr/bin:/bin:/usr/sbin:/sbin';
  }
  return env;
}

async function serviceToken(directory?: string): Promise<string> {
  const paths = runtimeServicePaths(directory);
  await ensureRuntimeEndpointDirectory(paths.endpoint);
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
  requirements?: Readonly<Record<string, string>>;
  administrative?: boolean;
} = {}): Promise<RuntimeClient> {
  const paths = runtimeServicePaths(options.directory);
  const token = (await readFile(paths.token, 'utf8')).trim();
  return RuntimeClient.connect({
    endpoint: paths.endpoint, token, requirements: options.requirements ?? {},
    administrative: options.administrative,
  });
}

function isMissingService(error: unknown): boolean {
  return ['ENOENT', 'ECONNREFUSED'].includes(String((error as NodeJS.ErrnoException).code));
}

export async function ensureRuntimeService(options: {
  directory?: string;
  requirements?: Readonly<Record<string, string>>;
  administrative?: boolean;
  bootstrapEnv?: NodeJS.ProcessEnv;
  /** Maximum time to establish the initial service connection. */
  startupTimeoutMs?: number;
} = {}): Promise<RuntimeClient> {
  const paths = runtimeServicePaths(options.directory);
  const token = await serviceToken(paths.root);
  const connect = () => RuntimeClient.connect({
    endpoint: paths.endpoint, token, requirements: options.requirements ?? {},
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
  let candidate: ReturnType<typeof spawn> | undefined;
  let candidateExited: Promise<void> | undefined;
  let discarded: Promise<void> | undefined;
  const discardCandidate = () => discarded ??= (async () => {
    const child = candidate;
    if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return;
    const force = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* the deadline reports unconfirmed cleanup */ }
    }, 2000);
    let deadline: ReturnType<typeof setTimeout> | undefined;
    try {
      try { child.kill('SIGTERM'); } catch { /* still attempt forced cleanup */ }
      await Promise.race([
        candidateExited!,
        new Promise<never>((_resolve, reject) => {
          deadline = setTimeout(() => reject(new RuntimeServiceError(
            'startup_cleanup_failed', 'The Runtime startup candidate did not exit; cleanup is unconfirmed.',
          )), 5000);
        }),
      ]);
    } finally { clearTimeout(force); clearTimeout(deadline); }
  })();

  try {
    try {
      const child = spawn(process.execPath, args, {
        detached: true,
        stdio: ['ignore', log.fd, log.fd],
        env: { ...(options.bootstrapEnv ?? runtimeServiceBootstrapEnvironment()) },
        cwd: paths.root,
      });
      candidate = child;
      candidateExited = new Promise<void>((resolve) => {
        child.once('exit', () => resolve());
        child.once('error', () => { if (!child.pid) resolve(); });
      });
      child.once('error', (error) => { launchError = error; });
      child.unref();
    } finally { await log.close(); }

    const deadline = Date.now() + (options.startupTimeoutMs ?? 30_000);
    while (Date.now() < deadline) {
      if (launchError) throw launchError;
      try {
        const client = await connect();
        try {
          // Only terminate our own child, never an established owner learned
          // from the endpoint or a lock file.
          if (candidate.pid !== client.pid) await discardCandidate();
          if (!client.isConnected) throw new RuntimeServiceError('connection_lost', 'Runtime service stopped during startup.');
          return client;
        } catch (error) { await client.close(); throw error; }
      }
      catch (error) { if (!isMissingService(error)) throw error; }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new RuntimeServiceError('startup_failed', `Runtime service did not start. Inspect ${paths.log}.`);
  } catch (error) {
    // A failed launch must not remain detached and start a service after the
    // caller has already been told startup failed.
    try { await discardCandidate(); }
    catch (cleanupError) {
      const original = error instanceof Error ? error.message : 'Runtime service startup failed.';
      throw Object.assign(new AggregateError(
        [error, cleanupError], `${original} Startup candidate cleanup is unconfirmed.`, { cause: error },
      ), { code: (error as NodeJS.ErrnoException)?.code });
    }
    throw error;
  }
}
