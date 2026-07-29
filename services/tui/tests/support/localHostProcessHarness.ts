import assert from 'node:assert/strict';
import {
  spawn,
  type ChildProcessWithoutNullStreams,
} from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HOST_SCRIPT = fileURLToPath(new URL(
  './localHostProcess.ts',
  import.meta.url,
));

export type HostProcess = {
  child: ChildProcessWithoutNullStreams;
  port: number;
  stderr: string[];
  exit: Promise<ProcessExit>;
};

export type ProcessExit = {
  code: number | null;
  signal: NodeJS.Signals | null;
  error?: Error;
};

export async function spawnHostProcess(options: {
  port: number;
  workdir: string;
  authToken: string;
  fixture?: 'persistent' | 'toolkit';
}): Promise<HostProcess> {
  const child = spawn(
    process.execPath,
    [
      'run',
      HOST_SCRIPT,
      String(options.port),
      options.workdir,
      options.authToken,
      options.fixture ?? 'persistent',
    ],
    {
      cwd: options.workdir,
      stdio: ['pipe', 'pipe', 'pipe'],
    },
  );
  child.stdin.end();
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');

  const stderr: string[] = [];
  child.stderr.on('data', (chunk: string) => {
    stderr.push(chunk);
  });
  const exit = processExit(child);
  let buffer = '';
  let resolveReady!: (port: number) => void;
  let rejectReady!: (error: Error) => void;
  const ready = new Promise<number>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  child.once('error', rejectReady);
  child.stdout.on('data', (chunk: string) => {
    buffer += chunk;
    let newline = buffer.indexOf('\n');
    while (newline >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      const message = parseReadyMessage(line);
      if (message) {
        resolveReady(message.port);
      }
      newline = buffer.indexOf('\n');
    }
  });
  void exit.then(({ code, signal }) => {
    rejectReady(new Error(
      `local host exited before ready: code=${code} signal=${signal}`
      + (stderr.length ? `\n${stderr.join('')}` : ''),
    ));
  });

  try {
    return {
      child,
      port: await withTimeout(ready, 4_000, 'local host startup'),
      stderr,
      exit,
    };
  } catch (error) {
    await terminateProcess(child, exit, 'failed local host shutdown');
    throw error;
  }
}

export async function stopHostProcess(host: HostProcess) {
  if (host.child.exitCode === null && host.child.signalCode === null) {
    host.child.kill('SIGTERM');
  }
  const result = await withTimeout(host.exit, 4_000, 'local host shutdown');
  assert.equal(
    result.error,
    undefined,
    `local host process error: ${result.error?.message}`,
  );
  assert.equal(
    result.code,
    0,
    `local host did not exit cleanly: signal=${result.signal}\n${host.stderr.join('')}`,
  );
}

export function processExit(child: ChildProcessWithoutNullStreams) {
  return new Promise<ProcessExit>((resolve) => {
    child.once('exit', (code, signal) => {
      resolve({ code, signal });
    });
    child.once('error', (error) => {
      resolve({
        code: null,
        signal: null,
        error,
      });
    });
  });
}

export async function terminateProcess(
  child: ChildProcessWithoutNullStreams,
  exit: Promise<ProcessExit>,
  label: string,
) {
  if (child.exitCode === null && child.signalCode === null) {
    child.kill('SIGTERM');
  }
  try {
    await withTimeout(exit, 1_000, label);
  } catch {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
    }
    await exit;
  }
}

export async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  label: string,
) {
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          reject(new Error(`${label} timed out after ${timeoutMs}ms`));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

function parseReadyMessage(line: string) {
  if (!line.startsWith('{')) return null;
  try {
    const value = JSON.parse(line) as {
      type?: unknown;
      port?: unknown;
    };
    return value.type === 'ready'
      && typeof value.port === 'number'
      && Number.isInteger(value.port)
      ? { port: value.port }
      : null;
  } catch {
    return null;
  }
}
