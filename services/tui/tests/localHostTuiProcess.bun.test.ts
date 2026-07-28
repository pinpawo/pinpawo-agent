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
  stripAnsiSequences,
} from '@opentui/core';
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
  PERSISTENT_HOST_ATTACHMENT_INPUT,
  PERSISTENT_HOST_ATTACHMENT_NAMES,
  PERSISTENT_HOST_ATTACHMENT_REPLY,
  PERSISTENT_HOST_EDITOR_INITIAL,
  PERSISTENT_HOST_EDITOR_INPUT,
  PERSISTENT_HOST_EDITOR_REPLY,
  PERSISTENT_HOST_INPUT,
  PERSISTENT_HOST_INVALID_ATTACHMENT_REPLY,
  PERSISTENT_HOST_MENTION_INPUT,
  PERSISTENT_HOST_MENTION_NAME,
  PERSISTENT_HOST_MENTION_REPLY,
  PERSISTENT_HOST_REPLY,
  PERSISTENT_HOST_REMOVED_ATTACHMENT_NAME,
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

test('production v2 process exercises composer workflows through a real PTY', {
  skip: process.platform !== 'darwin'
    ? 'macOS expect PTY smoke'
    : false,
}, async () => {
  const root = mkdtempSync(join(tmpdir(), 'pinpawo-tui-v2-pty-'));
  const workdir = join(root, 'workspace');
  const home = join(root, 'home');
  const [firstAttachmentName, secondAttachmentName] =
    PERSISTENT_HOST_ATTACHMENT_NAMES;
  const removedAttachmentName = PERSISTENT_HOST_REMOVED_ATTACHMENT_NAME;
  const firstAttachmentPath = join(workdir, firstAttachmentName);
  const secondAttachmentPath = join(workdir, secondAttachmentName);
  const removedAttachmentPath = join(workdir, removedAttachmentName);
  const mentionPath = join(workdir, PERSISTENT_HOST_MENTION_NAME);
  const editorScriptPath = join(root, 'visual-fixture.mjs');
  mkdirSync(workdir, { recursive: true });
  mkdirSync(join(home, '.pinpawo'), { recursive: true });
  writeFileSync(firstAttachmentPath, 'first attachment');
  writeFileSync(secondAttachmentPath, 'second attachment');
  writeFileSync(removedAttachmentPath, 'removed attachment');
  writeFileSync(mentionPath, 'workspace mention');
  writeFileSync(editorScriptPath, [
    "import { readFileSync, writeFileSync } from 'node:fs';",
    'const filePath = process.argv.at(-1);',
    "if (!filePath) throw new Error('missing editor file path');",
    `const expected = ${JSON.stringify(PERSISTENT_HOST_EDITOR_INITIAL)};`,
    "if (readFileSync(filePath, 'utf8') !== expected) {",
    "  throw new Error('unexpected initial editor draft');",
    '}',
    'writeFileSync(',
    `  filePath, ${JSON.stringify(`${PERSISTENT_HOST_EDITOR_INPUT}\n`)}, 'utf8',`,
    ');',
  ].join('\n'));
  writeFileSync(
    join(home, '.pinpawo', 'local-server-token'),
    `${AUTH_TOKEN}\n`,
    { mode: 0o600 },
  );
  const attachmentPaste = [
    '\x1b[200~',
    [
      `'${firstAttachmentPath}'`,
      `"${secondAttachmentPath}"`,
      `'${removedAttachmentPath}'`,
    ].join(' '),
    '\x1b[201~',
  ].join('');
  const checkpointUserText = [
    PERSISTENT_HOST_ATTACHMENT_INPUT,
    '',
    'Attachments:',
    `- file: ${firstAttachmentName}`,
    `- file: ${secondAttachmentName}`,
  ].join('\n');
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
      ].join(' '),
      'fconfigure $spawn_id -translation binary -encoding binary',
      'expect {',
      '  -re "process-restart-model" {}',
      '  timeout { exit 124 }',
      '  eof { exit 125 }',
      '}',
      `send -- [binary format H* ${utf8Hex(attachmentPaste)}]`,
      'after 100',
      'send -- "\\177"',
      'after 100',
      `send -- [binary format H* ${utf8Hex(PERSISTENT_HOST_ATTACHMENT_INPUT)}]`,
      'send -- "\\033\\[13;5u"',
      'expect {',
      `  -exact ${JSON.stringify(PERSISTENT_HOST_ATTACHMENT_REPLY)} {}`,
      '  timeout { exit 126 }',
      '  eof { exit 127 }',
      '}',
      `send -- [binary format H* ${utf8Hex(PERSISTENT_HOST_INPUT)}]`,
      'send -- "\\033\\[13;5u"',
      'expect {',
      `  -exact ${JSON.stringify(PERSISTENT_HOST_REPLY)} {}`,
      '  timeout { exit 128 }',
      '  eof { exit 129 }',
      '}',
      'send -- "\\033\\[A"',
      'after 100',
      'send -- "\\033\\[13;5u"',
      'expect {',
      `  -exact ${JSON.stringify(PERSISTENT_HOST_REPLY)} {}`,
      '  timeout { exit 130 }',
      '  eof { exit 131 }',
      '}',
      `send -- [binary format H* ${utf8Hex('Inspect @指南')}]`,
      'after 100',
      'send -- "\\t"',
      'after 100',
      `send -- [binary format H* ${utf8Hex('carefully.')}]`,
      'send -- "\\033\\[13;5u"',
      'expect {',
      `  -exact ${JSON.stringify(PERSISTENT_HOST_MENTION_REPLY)} {}`,
      '  timeout { exit 132 }',
      '  eof { exit 133 }',
      '}',
      `send -- [binary format H* ${utf8Hex('/ed')}]`,
      'after 100',
      'send -- "\\t"',
      'after 100',
      `send -- [binary format H* ${utf8Hex(PERSISTENT_HOST_EDITOR_INITIAL)}]`,
      'send -- "\\033\\[13;5u"',
      'expect {',
      '  -exact "external editor draft loaded" {}',
      '  timeout { exit 134 }',
      '  eof { exit 135 }',
      '}',
      'send -- "\\033\\[13;5u"',
      'expect {',
      `  -exact ${JSON.stringify(PERSISTENT_HOST_EDITOR_REPLY)} {}`,
      '  timeout { exit 136 }',
      '  eof { exit 137 }',
      '}',
      `send -- [binary format H* ${utf8Hex('/he')}]`,
      'after 100',
      'send -- "\\t"',
      'after 100',
      'send -- "\\033\\[13;5u"',
      'expect {',
      '  -exact "PgUp/PgDn" {}',
      '  timeout { exit 138 }',
      '  eof { exit 139 }',
      '}',
      'send -- "\\033"',
      'after 100',
      `send -- [binary format H* ${utf8Hex('/qu')}]`,
      'after 100',
      'send -- "\\t"',
      'after 100',
      'send -- "\\033\\[13;5u"',
      'expect {',
      '  eof {}',
      '  timeout { exit 140 }',
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
          VISUAL: [
            JSON.stringify(process.execPath),
            JSON.stringify(editorScriptPath),
          ].join(' '),
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
      15_000,
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
    const output = decodeExpectBinaryOutput(stdout.join(''));
    assert.match(output, /PinPawo TUI v2/);
    assert.match(output, /connected/);
    assert.match(output, /process-restart-model/);
    assert.ok(
      output.includes(PERSISTENT_HOST_ATTACHMENT_INPUT),
      'PTY output omitted the submitted composer text',
    );
    assert.ok(output.includes(PERSISTENT_HOST_ATTACHMENT_REPLY));
    assert.ok(!output.includes(PERSISTENT_HOST_INVALID_ATTACHMENT_REPLY));
    assert.ok(output.includes(firstAttachmentName));
    assert.ok(
      output.includes(secondAttachmentName),
      'PTY output omitted the Unicode attachment filename',
    );
    assert.ok(output.includes(PERSISTENT_HOST_MENTION_INPUT));
    assert.ok(output.includes(PERSISTENT_HOST_MENTION_REPLY));
    assert.ok(output.includes('external editor draft loaded'));
    assert.ok(output.includes(PERSISTENT_HOST_EDITOR_REPLY));
    assert.ok(output.includes('PgUp/PgDn'));
    const searchableOutput = compactTerminalObservation(output);
    assert.ok(
      !searchableOutput.includes(compactTerminalObservation(firstAttachmentPath)),
    );
    assert.ok(
      !searchableOutput.includes(compactTerminalObservation(secondAttachmentPath)),
    );
    assert.ok(
      !searchableOutput.includes(compactTerminalObservation(removedAttachmentPath)),
    );

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
        `user:${checkpointUserText}`,
        `assistant:${PERSISTENT_HOST_ATTACHMENT_REPLY}`,
        `user:${PERSISTENT_HOST_INPUT}`,
        `assistant:${PERSISTENT_HOST_REPLY}`,
        `user:${PERSISTENT_HOST_INPUT}`,
        `assistant:${PERSISTENT_HOST_REPLY}`,
        `user:${PERSISTENT_HOST_MENTION_INPUT}`,
        `assistant:${PERSISTENT_HOST_MENTION_REPLY}`,
        `user:${PERSISTENT_HOST_EDITOR_INPUT}`,
        `assistant:${PERSISTENT_HOST_EDITOR_REPLY}`,
      ],
    );
    const checkpointText = controller.getState().session.timeline.flatMap(
      (entry) => (
        entry.type === 'message' && entry.status === 'completed'
          ? [entry.text]
          : []
      ),
    ).join('\n');
    assert.ok(!checkpointText.includes(firstAttachmentPath));
    assert.ok(!checkpointText.includes(secondAttachmentPath));
    assert.ok(!checkpointText.includes(removedAttachmentName));
    assert.ok(!checkpointText.includes(removedAttachmentPath));
    assert.equal(controller.getState().session.sessionTokenUsage?.totalTokens, 35);
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

function utf8Hex(value: string) {
  return Buffer.from(value, 'utf8').toString('hex');
}

function decodeExpectBinaryOutput(value: string) {
  return Buffer.from(value, 'latin1').toString('utf8');
}

function compactTerminalObservation(value: string) {
  return stripAnsiSequences(value).replace(/\s+/g, '');
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
