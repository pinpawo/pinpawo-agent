import assert from 'node:assert/strict';
import {
  spawn,
  type ChildProcessWithoutNullStreams,
} from 'node:child_process';
import {
  mkdtempSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import {
  LocalHostConnection,
} from '../src/client/localHostConnection';
import {
  TuiSessionController,
} from '../src/session/sessionController';

const AUTH_TOKEN = 'tui-v2-process-restart-token';
const HOST_SCRIPT = fileURLToPath(new URL(
  './support/localHostProcess.ts',
  import.meta.url,
));

test('v2 reconnects after the production local host process restarts', async () => {
  const workdir = mkdtempSync(join(tmpdir(), 'pinpawo-tui-v2-process-'));
  let firstHost: HostProcess | null = null;
  let secondHost: HostProcess | null = null;
  let controller: TuiSessionController | null = null;

  try {
    firstHost = await spawnHostProcess(0, workdir);
    const observedConnections: string[] = [];
    let requestIndex = 0;
    controller = new TuiSessionController({
      connectionFactory: (handlers) => new LocalHostConnection(handlers, {
        port: firstHost!.port,
        tokenProvider: () => AUTH_TOKEN,
      }),
      requestIdFactory: () => `process-request-${requestIndex += 1}`,
      reconnectDelaysMs: [25, 50, 100, 200, 400, 800],
      snapshotTimeoutMs: 1_000,
    });
    controller.subscribe((state) => {
      observedConnections.push(state.connection);
    });
    controller.start();
    await waitFor(() => controller?.getState().connection === 'ready');

    const originalSessionId = controller.getState().session.sessionId;
    assert.notEqual(originalSessionId, 'pending');
    assert.deepEqual(controller.getState().session.timeline, []);

    await stopHostProcess(firstHost);
    await waitFor(() => (
      controller?.getState().connection === 'reconnecting'
      || controller?.getState().connection === 'disconnected'
    ));

    secondHost = await spawnHostProcess(firstHost.port, workdir);
    assert.equal(secondHost.port, firstHost.port);
    await waitFor(() => (
      controller?.getState().connection === 'ready'
      && controller.getState().session.sessionId === originalSessionId
    ), 4_000);

    assert.ok(observedConnections.includes('reconnecting'));
    assert.equal(controller.getState().session.sessionId, originalSessionId);
    assert.deepEqual(controller.getState().session.timeline, []);
  } finally {
    controller?.stop();
    if (secondHost) {
      await stopHostProcess(secondHost);
    }
    if (firstHost) {
      await stopHostProcess(firstHost);
    }
    rmSync(workdir, { recursive: true, force: true });
  }
});

type HostProcess = {
  child: ChildProcessWithoutNullStreams;
  port: number;
  stderr: string[];
  exit: Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
  }>;
};

async function spawnHostProcess(
  port: number,
  workdir: string,
): Promise<HostProcess> {
  const child = spawn(
    process.execPath,
    ['run', HOST_SCRIPT, String(port), workdir, AUTH_TOKEN],
    {
      cwd: workdir,
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
  const exit = new Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
  }>((resolve) => {
    child.once('exit', (code, signal) => {
      resolve({ code, signal });
    });
  });
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
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM');
    }
    try {
      await withTimeout(exit, 1_000, 'failed local host shutdown');
    } catch {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGKILL');
      }
      await exit;
    }
    throw error;
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

async function stopHostProcess(host: HostProcess) {
  if (host.child.exitCode === null && host.child.signalCode === null) {
    host.child.kill('SIGTERM');
  }
  const result = await withTimeout(host.exit, 4_000, 'local host shutdown');
  assert.equal(
    result.code,
    0,
    `local host did not exit cleanly: signal=${result.signal}\n${host.stderr.join('')}`,
  );
}

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 2_000,
) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error(`condition was not met within ${timeoutMs}ms`);
    }
    await Bun.sleep(10);
  }
}

async function withTimeout<T>(
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
