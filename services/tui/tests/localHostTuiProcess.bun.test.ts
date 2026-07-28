import assert from 'node:assert/strict';
import {
  spawn,
  type ChildProcessWithoutNullStreams,
} from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
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
import {
  processExit,
  spawnHostProcess,
  stopHostProcess,
  terminateProcess,
  withTimeout,
  type HostProcess,
} from './support/localHostProcessHarness';
import {
  PERSISTENT_HOST_INPUT,
  PERSISTENT_HOST_REPLY,
} from './support/persistentHostGraphService';

const AUTH_TOKEN = 'tui-v2-production-pty-token';
const TUI_ENTRY = fileURLToPath(new URL('../src/main.ts', import.meta.url));

test('process harness settles a spawn error without waiting for exit', async () => {
  const child = spawn(
    '/definitely/missing/pinpawo-tui-process',
    [],
    { stdio: ['pipe', 'pipe', 'pipe'] },
  );
  const exit = processExit(child);
  const result = await withTimeout(exit, 500, 'spawn error');

  assert.equal(result.code, null);
  assert.equal(result.signal, null);
  assert.match(result.error?.message ?? '', /ENOENT/);
  await terminateProcess(child, exit, 'spawn error cleanup');
});

test('production v2 process submits a chat through a real PTY', {
  skip: process.platform !== 'darwin'
    ? 'macOS expect PTY smoke'
    : false,
}, async () => {
  const root = mkdtempSync(join(tmpdir(), 'pinpawo-tui-v2-pty-'));
  const workdir = join(root, 'workspace');
  const home = join(root, 'home');
  mkdirSync(workdir, { recursive: true });
  mkdirSync(join(home, '.pinpawo'), { recursive: true });
  writeFileSync(
    join(home, '.pinpawo', 'local-server-token'),
    `${AUTH_TOKEN}\n`,
    { mode: 0o600 },
  );
  let host: HostProcess | null = null;
  let tui: ChildProcessWithoutNullStreams | null = null;
  let tuiExit: ReturnType<typeof processExit> | null = null;
  let controller: TuiSessionController | null = null;

  try {
    host = await spawnHostProcess({
      port: 0,
      workdir,
      authToken: AUTH_TOKEN,
    });
    const expectScript = [
      'set timeout 5',
      [
        'spawn -noecho',
        JSON.stringify(process.execPath),
        'run',
        JSON.stringify(TUI_ENTRY),
        '--smoke-host-chat',
      ].join(' '),
      'expect {',
      '  -re "process-restart-model" {}',
      '  timeout { exit 124 }',
      '  eof { exit 125 }',
      '}',
      `send -- ${JSON.stringify(PERSISTENT_HOST_INPUT)}`,
      'send -- "\\033\\[13;5u"',
      'expect {',
      '  eof {}',
      '  timeout { exit 126 }',
      '}',
      'set result [wait]',
      'exit [lindex $result 3]',
    ].join('\n');
    tui = spawn(
      '/usr/bin/expect',
      [
        '-c',
        expectScript,
      ],
      {
        cwd: workdir,
        env: {
          ...process.env,
          HOME: home,
          LOCAL_SERVER_PORT: String(host.port),
          TERM: 'xterm-256color',
        },
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    );
    tui.stdout.setEncoding('utf8');
    tui.stderr.setEncoding('utf8');
    const stdout: string[] = [];
    const stderr: string[] = [];
    tui.stdout.on('data', (chunk: string) => stdout.push(chunk));
    tui.stderr.on('data', (chunk: string) => stderr.push(chunk));
    tuiExit = processExit(tui);

    const result = await withTimeout(
      tuiExit,
      8_000,
      'production TUI PTY chat',
    );
    assert.equal(
      result.error,
      undefined,
      `could not start TUI PTY: ${result.error?.message}`,
    );
    assert.equal(
      result.code,
      0,
      `TUI PTY failed: signal=${result.signal}\n${stderr.join('')}`,
    );
    const output = stdout.join('');
    assert.match(output, /PinPawo TUI v2/);
    assert.match(output, /connected/);
    assert.match(output, /process-restart-model/);
    assert.ok(output.includes(PERSISTENT_HOST_INPUT));
    assert.ok(output.includes(PERSISTENT_HOST_REPLY));

    const hostPort = host.port;
    await stopHostProcess(host);
    host = null;
    host = await spawnHostProcess({
      port: hostPort,
      workdir,
      authToken: AUTH_TOKEN,
    });
    controller = new TuiSessionController({
      connectionFactory: (handlers) => new LocalHostConnection(handlers, {
        port: hostPort,
        tokenProvider: () => AUTH_TOKEN,
      }),
      requestIdFactory: () => 'pty-checkpoint-snapshot',
      reconnectDelaysMs: [25],
      snapshotTimeoutMs: 1_000,
    });
    controller.start();
    await waitFor(() => controller?.getState().connection === 'ready');
    assert.deepEqual(
      controller.getState().session.timeline.flatMap((entry) => (
        entry.type === 'message' && entry.status === 'completed'
          ? [`${entry.role}:${entry.text}`]
          : []
      )),
      [
        `user:${PERSISTENT_HOST_INPUT}`,
        `assistant:${PERSISTENT_HOST_REPLY}`,
      ],
    );
    assert.equal(controller.getState().session.sessionTokenUsage?.totalTokens, 7);
  } finally {
    controller?.stop();
    if (tui && tuiExit) {
      tui.stdin.end();
      await terminateProcess(tui, tuiExit, 'production TUI PTY cleanup');
    }
    if (host) {
      await stopHostProcess(host);
    }
    rmSync(root, { recursive: true, force: true });
  }
});

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
