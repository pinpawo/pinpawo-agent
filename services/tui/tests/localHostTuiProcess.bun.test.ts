import assert from 'node:assert/strict';
import {
  spawn,
  type ChildProcessWithoutNullStreams,
} from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
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
  ATTACHMENT_FILE_CONTENT,
  ATTACHMENT_FILE_NAME,
  ATTACHMENT_TOOL_INPUT,
  ATTACHMENT_TOOL_NAME,
  ATTACHMENT_TOOL_OUTPUT,
  ATTACHMENT_TOOL_REPLY,
  GUARDED_HOST_CONTINUATION_GUIDANCE,
  GUARDED_HOST_INPUT,
  GUARDED_HOST_OUTPUT_CONTENT,
  GUARDED_HOST_OUTPUT_NAME,
  GUARDED_HOST_REPLY,
  GUARDED_HOST_REVIEW_TITLE,
  GUARDED_HOST_TOOL_NAME,
  GUARDED_HOST_TOOL_OUTPUT,
} from './support/productionToolkitHostGraphService';
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
  PERSISTENT_HOST_RESIZE_INPUT,
  PERSISTENT_HOST_RESIZE_REPLY,
  PERSISTENT_HOST_REVIEW_APPROVED_REPLY,
  PERSISTENT_HOST_REVIEW_INPUT,
  PERSISTENT_HOST_REVIEW_REJECTED_REPLY,
  PERSISTENT_HOST_REVIEW_SPEC,
  PERSISTENT_HOST_TIMELINE_INPUT,
  PERSISTENT_HOST_TIMELINE_REPLY,
  PERSISTENT_HOST_TIMELINE_SUBAGENT,
  PERSISTENT_HOST_TIMELINE_TOOL_OUTPUT,
  PERSISTENT_HOST_TIMELINE_TOOL_UPDATE,
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

test('production v2 accepts input after starting before the first local host and auth token', {
  skip: process.platform !== 'darwin'
    ? 'macOS expect PTY smoke'
    : false,
  timeout: 15_000,
}, async () => {
  const root = mkdtempSync(join(tmpdir(), 'pinpawo-tui-v2-late-host-'));
  const workdir = join(root, 'workspace');
  const home = join(root, 'home');
  mkdirSync(workdir, { recursive: true });
  mkdirSync(join(home, '.pinpawo'), { recursive: true });
  let host: HostProcess | null = null;
  let tui: ChildProcessWithoutNullStreams | null = null;
  let tuiExit: ReturnType<typeof processExit> | null = null;

  try {
    host = await spawnHostProcess({
      port: 0,
      workdir,
      authToken: AUTH_TOKEN,
    });
    const hostPort = host.port;
    await stopHostProcess(host);
    host = null;

    const expectScript = [
      'set timeout 10',
      [
        'spawn -noecho',
        JSON.stringify(process.execPath),
        'run',
        JSON.stringify(TUI_ENTRY),
      ].join(' '),
      'fconfigure $spawn_id -translation binary -encoding binary',
      // Dismiss the first connection error while retries continue. Recovery
      // must restore composer focus before the Enter submission below.
      'after 700',
      'send -- "\\033"',
      'expect {',
      '  -re "process-restart-model" {}',
      '  timeout { exit 150 }',
      '  eof { exit 151 }',
      '}',
      `send -- [binary format H* ${utf8Hex(PERSISTENT_HOST_INPUT)}]`,
      'send -- "\\r"',
      'expect {',
      `  -exact ${JSON.stringify(PERSISTENT_HOST_REPLY)} {}`,
      '  timeout { exit 152 }',
      '  eof { exit 153 }',
      '}',
      `send -- [binary format H* ${utf8Hex('/quit')}]`,
      'send -- "\\r"',
      'expect {',
      '  eof {}',
      '  timeout { exit 154 }',
      '}',
      'set result [wait]',
      'exit [lindex $result 3]',
    ].join('\n');
    tui = spawn('/usr/bin/expect', ['-c', expectScript], {
      cwd: workdir,
      env: {
        ...process.env,
        HOME: home,
        LOCAL_SERVER_PORT: String(hostPort),
        TERM: 'xterm-256color',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    tui.stdout.setEncoding('utf8');
    tui.stderr.setEncoding('utf8');
    const stdout: string[] = [];
    const stderr: string[] = [];
    tui.stdout.on('data', (chunk: string) => stdout.push(chunk));
    tui.stderr.on('data', (chunk: string) => stderr.push(chunk));
    tuiExit = processExit(tui);

    await Bun.sleep(900);
    writeFileSync(
      join(home, '.pinpawo', 'local-server-token'),
      `${AUTH_TOKEN}\n`,
      { mode: 0o600 },
    );
    host = await spawnHostProcess({
      port: hostPort,
      workdir,
      authToken: AUTH_TOKEN,
    });

    const result = await withTimeout(
      tuiExit,
      12_000,
      'late-host production TUI PTY',
    );
    assert.equal(
      result.error,
      undefined,
      `TUI PTY error: ${result.error?.message}`,
    );
    assert.equal(
      result.code,
      0,
      [
        `late-host TUI exited with signal=${result.signal}`,
        decodeExpectBinaryOutput(stdout.join('')),
        stderr.join(''),
      ].join('\n'),
    );
  } finally {
    if (tui && tuiExit) {
      tui.stdin.end();
      await terminateProcess(tui, tuiExit, 'late-host TUI PTY cleanup');
    }
    if (host) {
      await stopHostProcess(host);
    }
    rmSync(root, { recursive: true, force: true });
  }
});

test('production v2 preserves an active-run draft across PTY resize', {
  skip: process.platform !== 'darwin'
    ? 'macOS expect PTY smoke'
    : false,
  timeout: 15_000,
}, async () => {
  const root = mkdtempSync(join(tmpdir(), 'pinpawo-tui-v2-resize-'));
  const workdir = join(root, 'workspace');
  const home = join(root, 'home');
  const draft = [
    '# Draft survives the narrow resize.',
    '第二行 **仍然** 可以提交 `code` 🙂。',
  ].join('\n');
  const draftPaste = `\x1b[200~${draft}\x1b[201~`;
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

  try {
    host = await spawnHostProcess({
      port: 0,
      workdir,
      authToken: AUTH_TOKEN,
    });
    const expectScript = [
      'set timeout 8',
      'set stty_init "rows 24 columns 80"',
      [
        'spawn -noecho',
        JSON.stringify(process.execPath),
        'run',
        JSON.stringify(TUI_ENTRY),
      ].join(' '),
      'fconfigure $spawn_id -translation binary -encoding binary',
      'expect {',
      '  -re "process-restart-model" {}',
      '  timeout { exit 171 }',
      '  eof { exit 172 }',
      '}',
      `send -- [binary format H* ${utf8Hex(PERSISTENT_HOST_RESIZE_INPUT)}]`,
      'send -- "\\r"',
      'expect {',
      '  -exact "PinPawo is thinking" {}',
      '  timeout { exit 173 }',
      '  eof { exit 174 }',
      '}',
      `send -- [binary format H* ${utf8Hex(draftPaste)}]`,
      'after 80',
      'exec /bin/stty -f $spawn_out(slave,name) rows 18 columns 44',
      'after 120',
      'exec /bin/stty -f $spawn_out(slave,name) rows 28 columns 96',
      'expect {',
      `  -exact ${JSON.stringify(PERSISTENT_HOST_RESIZE_REPLY)} {}`,
      '  timeout { exit 175 }',
      '  eof { exit 176 }',
      '}',
      'send -- "\\r"',
      'expect {',
      `  -exact ${JSON.stringify(PERSISTENT_HOST_REPLY)} {}`,
      '  timeout { exit 177 }',
      '  eof { exit 178 }',
      '}',
      `send -- [binary format H* ${utf8Hex('/quit')}]`,
      'send -- "\\r"',
      'expect {',
      '  eof {}',
      '  timeout { exit 179 }',
      '}',
      'set result [wait]',
      'exit [lindex $result 3]',
    ].join('\n');
    tui = spawn('/usr/bin/expect', ['-c', expectScript], {
      cwd: workdir,
      env: {
        ...process.env,
        HOME: home,
        LOCAL_SERVER_PORT: String(host.port),
        TERM: 'xterm-256color',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    tui.stdout.setEncoding('utf8');
    tui.stderr.setEncoding('utf8');
    const stdout: string[] = [];
    const stderr: string[] = [];
    tui.stdout.on('data', (chunk: string) => stdout.push(chunk));
    tui.stderr.on('data', (chunk: string) => stderr.push(chunk));
    tuiExit = processExit(tui);

    const result = await withTimeout(
      tuiExit,
      12_000,
      'production TUI PTY resize',
    );
    const output = decodeExpectBinaryOutput(stdout.join(''));
    assert.equal(
      result.code,
      0,
      [
        `resize TUI PTY failed: signal=${result.signal}`,
        stderr.join(''),
        output.slice(-4_000),
      ].join('\n'),
    );
    const searchableOutput = compactTerminalObservation(output);
    assertOrderedSubstrings(searchableOutput, [
      compactTerminalObservation(PERSISTENT_HOST_RESIZE_INPUT),
      compactTerminalObservation('PinPawo is thinking'),
      compactTerminalObservation(PERSISTENT_HOST_RESIZE_REPLY),
      compactTerminalObservation(draft),
      compactTerminalObservation(PERSISTENT_HOST_REPLY),
    ], 'active-run resize and draft submission');
  } finally {
    if (tui && tuiExit) {
      tui.stdin.end();
      await terminateProcess(tui, tuiExit, 'resize TUI PTY cleanup');
    }
    if (host) {
      await stopHostProcess(host);
    }
    rmSync(root, { recursive: true, force: true });
  }
});

test('production v2 reconciles a response completed while the pager owns the TTY', {
  skip: process.platform !== 'darwin'
    ? 'macOS expect PTY smoke'
    : false,
  timeout: 15_000,
}, async () => {
  const root = mkdtempSync(join(tmpdir(), 'pinpawo-tui-v2-live-pager-'));
  const workdir = join(root, 'workspace');
  const home = join(root, 'home');
  const pagerScriptPath = join(root, 'blocking-pager.mjs');
  const pagerSentinelPath = join(root, 'pager-state.txt');
  mkdirSync(workdir, { recursive: true });
  mkdirSync(join(home, '.pinpawo'), { recursive: true });
  writeFileSync(
    join(home, '.pinpawo', 'local-server-token'),
    `${AUTH_TOKEN}\n`,
    { mode: 0o600 },
  );
  writeFileSync(pagerScriptPath, [
    "import { writeFileSync } from 'node:fs';",
    `const sentinel = ${JSON.stringify(pagerSentinelPath)};`,
    "writeFileSync(sentinel, 'opened', 'utf8');",
    'await new Promise((resolve) => setTimeout(resolve, 900));',
    "writeFileSync(sentinel, 'closed', 'utf8');",
  ].join('\n'));
  let host: HostProcess | null = null;
  let tui: ChildProcessWithoutNullStreams | null = null;
  let tuiExit: ReturnType<typeof processExit> | null = null;

  try {
    host = await spawnHostProcess({
      port: 0,
      workdir,
      authToken: AUTH_TOKEN,
    });
    const expectScript = [
      'set timeout 8',
      [
        'spawn -noecho',
        JSON.stringify(process.execPath),
        'run',
        JSON.stringify(TUI_ENTRY),
      ].join(' '),
      'fconfigure $spawn_id -translation binary -encoding binary',
      'expect {',
      '  -re "process-restart-model" {}',
      '  timeout { exit 180 }',
      '  eof { exit 181 }',
      '}',
      `send -- [binary format H* ${utf8Hex(PERSISTENT_HOST_RESIZE_INPUT)}]`,
      'send -- "\\r"',
      'expect {',
      '  -exact "PinPawo is thinking" {}',
      '  timeout { exit 182 }',
      '  eof { exit 183 }',
      '}',
      'send -- "\\033\\[5~"',
      'expect {',
      '  -exact "transcript closed" {}',
      '  timeout { exit 184 }',
      '  eof { exit 185 }',
      '}',
      `send -- [binary format H* ${utf8Hex('/quit')}]`,
      'send -- "\\r"',
      'expect {',
      '  eof {}',
      '  timeout { exit 186 }',
      '}',
      'set result [wait]',
      'exit [lindex $result 3]',
    ].join('\n');
    tui = spawn('/usr/bin/expect', ['-c', expectScript], {
      cwd: workdir,
      env: {
        ...process.env,
        HOME: home,
        LOCAL_SERVER_PORT: String(host.port),
        TERM: 'xterm-256color',
        PAGER: [
          JSON.stringify(process.execPath),
          JSON.stringify(pagerScriptPath),
        ].join(' '),
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    tui.stdout.setEncoding('utf8');
    tui.stderr.setEncoding('utf8');
    const stdout: string[] = [];
    const stderr: string[] = [];
    tui.stdout.on('data', (chunk: string) => stdout.push(chunk));
    tui.stderr.on('data', (chunk: string) => stderr.push(chunk));
    tuiExit = processExit(tui);

    const result = await withTimeout(
      tuiExit,
      12_000,
      'production TUI live pager',
    );
    const output = decodeExpectBinaryOutput(stdout.join(''));
    assert.equal(
      result.code,
      0,
      [
        `live-pager TUI PTY failed: signal=${result.signal}`,
        stderr.join(''),
        output.slice(-4_000),
      ].join('\n'),
    );
    assert.equal(readFileSync(pagerSentinelPath, 'utf8'), 'closed');
    const searchableOutput = compactTerminalObservation(output);
    assertOrderedSubstrings(searchableOutput, [
      compactTerminalObservation(PERSISTENT_HOST_RESIZE_INPUT),
      compactTerminalObservation('PinPawo is thinking'),
      compactTerminalObservation(PERSISTENT_HOST_RESIZE_REPLY),
      compactTerminalObservation('transcript closed'),
    ], 'response completed during pager handoff');
  } finally {
    if (tui && tuiExit) {
      tui.stdin.end();
      await terminateProcess(tui, tuiExit, 'live-pager TUI PTY cleanup');
    }
    if (host) {
      await stopHostProcess(host);
    }
    rmSync(root, { recursive: true, force: true });
  }
});

test('production v2 process exercises composer workflows through a real PTY', {
  skip: process.platform !== 'darwin'
    ? 'macOS expect PTY smoke'
    : false,
  timeout: 20_000,
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
  const pagerScriptPath = join(root, 'pager-fixture.mjs');
  const pagerSentinelPath = join(root, 'pager-validated.txt');
  const transcriptExportPath = join(workdir, 'exported-transcript.md');
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
  const orderedChatValues = [
    PERSISTENT_HOST_ATTACHMENT_INPUT,
    firstAttachmentName,
    secondAttachmentName,
    PERSISTENT_HOST_ATTACHMENT_REPLY,
    PERSISTENT_HOST_INPUT,
    PERSISTENT_HOST_REPLY,
    PERSISTENT_HOST_INPUT,
    PERSISTENT_HOST_REPLY,
    PERSISTENT_HOST_MENTION_INPUT,
    PERSISTENT_HOST_MENTION_REPLY,
    PERSISTENT_HOST_EDITOR_INPUT,
    PERSISTENT_HOST_EDITOR_REPLY,
  ];
  const orderedExportValues = [
    ...orderedChatValues,
    PERSISTENT_HOST_TIMELINE_INPUT,
    PERSISTENT_HOST_TIMELINE_REPLY,
    PERSISTENT_HOST_REVIEW_INPUT,
    PERSISTENT_HOST_REVIEW_APPROVED_REPLY,
  ];
  const orderedPagerValues = [
    ...orderedChatValues.flatMap((value) => value.split('\n')),
    PERSISTENT_HOST_TIMELINE_INPUT,
    'read_fixture',
    PERSISTENT_HOST_TIMELINE_TOOL_OUTPUT,
    PERSISTENT_HOST_TIMELINE_SUBAGENT,
    ...PERSISTENT_HOST_TIMELINE_REPLY.split('\n').filter(Boolean),
    PERSISTENT_HOST_REVIEW_INPUT,
    PERSISTENT_HOST_REVIEW_APPROVED_REPLY,
  ];
  const privateTranscriptValues = [
    firstAttachmentPath,
    secondAttachmentPath,
    removedAttachmentName,
    removedAttachmentPath,
    '<local_attachments>',
  ];
  writeFileSync(
    pagerScriptPath,
    createPagerFixtureSource({
      orderedValues: orderedPagerValues,
      forbiddenValues: privateTranscriptValues,
      sentinelPath: pagerSentinelPath,
    }),
  );
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
      'send -- "\\r"',
      'expect {',
      `  -exact ${JSON.stringify(PERSISTENT_HOST_ATTACHMENT_REPLY)} {}`,
      '  timeout { exit 126 }',
      '  eof { exit 127 }',
      '}',
      `send -- [binary format H* ${utf8Hex(PERSISTENT_HOST_INPUT)}]`,
      'send -- "\\r"',
      'expect {',
      '  -exact "thinking" {}',
      '  timeout { exit 128 }',
      '  eof { exit 129 }',
      '}',
      'expect {',
      `  -exact ${JSON.stringify(PERSISTENT_HOST_REPLY)} {}`,
      '  timeout { exit 130 }',
      '  eof { exit 131 }',
      '}',
      'send -- "\\033\\[A"',
      'after 100',
      'send -- "\\r"',
      'expect {',
      `  -exact ${JSON.stringify(PERSISTENT_HOST_REPLY)} {}`,
      '  timeout { exit 132 }',
      '  eof { exit 133 }',
      '}',
      `send -- [binary format H* ${utf8Hex('Inspect @指南')}]`,
      'after 100',
      'send -- "\\t"',
      'after 100',
      `send -- [binary format H* ${utf8Hex('carefully.')}]`,
      'send -- "\\r"',
      'expect {',
      `  -exact ${JSON.stringify(PERSISTENT_HOST_MENTION_REPLY)} {}`,
      '  timeout { exit 134 }',
      '  eof { exit 135 }',
      '}',
      `send -- [binary format H* ${utf8Hex('/ed')}]`,
      'after 100',
      'send -- "\\t"',
      'after 100',
      `send -- [binary format H* ${utf8Hex(PERSISTENT_HOST_EDITOR_INITIAL)}]`,
      'send -- "\\r"',
      'expect {',
      '  -exact "external editor draft loaded" {}',
      '  timeout { exit 136 }',
      '  eof { exit 137 }',
      '}',
      'send -- "\\r"',
      'expect {',
      `  -exact ${JSON.stringify(PERSISTENT_HOST_EDITOR_REPLY)} {}`,
      '  timeout { exit 138 }',
      '  eof { exit 139 }',
      '}',
      `send -- [binary format H* ${utf8Hex(PERSISTENT_HOST_TIMELINE_INPUT)}]`,
      'send -- "\\r"',
      'expect {',
      '  -exact "is aligned." {}',
      '  timeout { exit 140 }',
      '  eof { exit 141 }',
      '}',
      // The matching phrase is visible in a delta. Wait for the authoritative
      // run settlement reflected by the live row before starting another turn.
      'expect {',
      '  -exact "idle" {}',
      '  timeout { exit 152 }',
      '  eof { exit 153 }',
      '}',
      `send -- [binary format H* ${utf8Hex(PERSISTENT_HOST_REVIEW_INPUT)}]`,
      'send -- "\\r"',
      'set review_body_ready 0',
      'set review_footer_ready 0',
      'while {!$review_body_ready || !$review_footer_ready} {',
      '  expect {',
      `    -exact ${JSON.stringify(PERSISTENT_HOST_REVIEW_SPEC.view.body)} { set review_body_ready 1 }`,
      '    -exact "PgUp/PgDn details" { set review_footer_ready 1 }',
      '    timeout { exit 142 }',
      '    eof { exit 143 }',
      '  }',
      '}',
      `send -- [binary format H* ${utf8Hex('approval-input-must-not-leak')}]`,
      'after 100',
      'send -- "\\033\\[13u"',
      'expect {',
      `  -exact ${JSON.stringify(PERSISTENT_HOST_REVIEW_APPROVED_REPLY)} {}`,
      '  timeout { exit 144 }',
      '  eof { exit 145 }',
      '}',
      `send -- [binary format H* ${utf8Hex('/tra')}]`,
      'after 100',
      'send -- "\\t"',
      'after 100',
      'send -- "\\r"',
      'expect {',
      '  -exact "transcript closed" {}',
      '  timeout { exit 146 }',
      '  eof { exit 147 }',
      '}',
      `send -- [binary format H* ${utf8Hex('/exp')}]`,
      'after 100',
      'send -- "\\t"',
      'after 100',
      `send -- [binary format H* ${utf8Hex(transcriptExportPath)}]`,
      'send -- "\\r"',
      `set export_path ${JSON.stringify(transcriptExportPath)}`,
      'set export_ready 0',
      'for {set attempt 0} {$attempt < 200} {incr attempt} {',
      '  if {[file exists $export_path]} {',
      '    set export_ready 1',
      '    break',
      '  }',
      '  after 25',
      '}',
      'if {!$export_ready} { exit 148 }',
      'after 100',
      `send -- [binary format H* ${utf8Hex('/he')}]`,
      'after 100',
      'send -- "\\t"',
      'after 100',
      'send -- "\\r"',
      'expect {',
      '  -exact "PgUp/PgDn" {}',
      '  timeout { exit 149 }',
      '  eof { exit 150 }',
      '}',
      'send -- "\\033"',
      'after 100',
      `send -- [binary format H* ${utf8Hex('/qu')}]`,
      'after 100',
      'send -- "\\t"',
      'after 100',
      'send -- "\\r"',
      'expect {',
      '  eof {}',
      '  timeout { exit 151 }',
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
          PAGER: [
            JSON.stringify(process.execPath),
            JSON.stringify(pagerScriptPath),
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
    const output = decodeExpectBinaryOutput(stdout.join(''));
    assert.equal(
      result.code,
      0,
      [
        `TUI PTY failed: signal=${result.signal}`,
        stderr.join(''),
        output.slice(-4_000),
      ].join('\n'),
    );
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
    assert.ok(output.includes(PERSISTENT_HOST_TIMELINE_INPUT));
    assert.ok(output.includes(PERSISTENT_HOST_TIMELINE_TOOL_OUTPUT));
    assert.ok(output.includes(PERSISTENT_HOST_TIMELINE_SUBAGENT));
    assert.ok(output.includes('Ordered result'));
    assert.ok(output.includes(PERSISTENT_HOST_REVIEW_APPROVED_REPLY));
    assert.ok(!output.includes(PERSISTENT_HOST_REVIEW_REJECTED_REPLY));
    assert.ok(!output.includes('approval-input-must-not-leak'));
    assert.ok(output.includes('transcript closed'));
    assert.ok(output.includes('PgUp/PgDn'));
    const searchableOutput = compactTerminalObservation(output);
    assert.ok(searchableOutput.includes(
      compactTerminalObservation(PERSISTENT_HOST_REVIEW_SPEC.view.title),
    ));
    assert.ok(searchableOutput.includes(
      compactTerminalObservation(PERSISTENT_HOST_REVIEW_SPEC.view.body),
    ));
    assert.ok(searchableOutput.includes(
      compactTerminalObservation(PERSISTENT_HOST_TIMELINE_TOOL_UPDATE),
    ));
    assertLastOrderedSubstrings(searchableOutput, [
      compactTerminalObservation('read_fixture'),
      compactTerminalObservation(PERSISTENT_HOST_TIMELINE_TOOL_OUTPUT),
      compactTerminalObservation(PERSISTENT_HOST_TIMELINE_SUBAGENT),
      compactTerminalObservation('Ordered result'),
      compactTerminalObservation('The production timeline is aligned.'),
    ], 'production terminal timeline');
    assert.ok(
      !searchableOutput.includes(compactTerminalObservation(firstAttachmentPath)),
    );
    assert.ok(
      !searchableOutput.includes(compactTerminalObservation(secondAttachmentPath)),
    );
    assert.ok(
      !searchableOutput.includes(compactTerminalObservation(removedAttachmentPath)),
    );
    assert.equal(
      readFileSync(pagerSentinelPath, 'utf8'),
      'validated',
      'production TUI did not hand the ordered snapshot to the PAGER child',
    );
    const exportedTranscript = readFileSync(transcriptExportPath, 'utf8');
    assert.match(exportedTranscript, /^# PinPawo TUI Transcript/m);
    assertOrderedSubstrings(
      exportedTranscript,
      orderedExportValues,
      'exported transcript',
    );
    for (const privateValue of privateTranscriptValues) {
      assert.ok(
        !exportedTranscript.includes(privateValue),
        `exported transcript leaked ${JSON.stringify(privateValue)}`,
      );
    }

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
        `user:${PERSISTENT_HOST_TIMELINE_INPUT}`,
        `assistant:${PERSISTENT_HOST_TIMELINE_REPLY}`,
        `user:${PERSISTENT_HOST_REVIEW_INPUT}`,
        `assistant:${PERSISTENT_HOST_REVIEW_APPROVED_REPLY}`,
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
    assert.equal(controller.getState().session.sessionTokenUsage?.totalTokens, 49);
    assert.equal(controller.getState().session.activeRun, null);
    assert.ok(controller.getState().session.timeline.every((entry) => (
      entry.type !== 'operation'
      && (entry.type !== 'message' || entry.role !== 'subagent')
    )));
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

test('production v2 executes reviewed and attachment toolkit calls through a real PTY', {
  skip: process.platform !== 'darwin'
    ? 'macOS expect PTY production-toolkit dogfood'
    : false,
  timeout: 15_000,
}, async () => {
  const root = mkdtempSync(join(tmpdir(), 'pinpawo-tui-v2-toolkit-'));
  const workdir = join(root, 'workspace');
  const home = join(root, 'home');
  const outputPath = join(workdir, GUARDED_HOST_OUTPUT_NAME);
  const attachmentPath = join(workdir, ATTACHMENT_FILE_NAME);
  const attachmentPaste = [
    '\x1b[200~',
    `'${attachmentPath}'`,
    '\x1b[201~',
  ].join('');
  const checkpointAttachmentText = [
    ATTACHMENT_TOOL_INPUT,
    '',
    'Attachments:',
    `- file: ${ATTACHMENT_FILE_NAME}`,
  ].join('\n');
  mkdirSync(workdir, { recursive: true });
  mkdirSync(join(home, '.pinpawo'), { recursive: true });
  writeFileSync(attachmentPath, ATTACHMENT_FILE_CONTENT);
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
      fixture: 'toolkit',
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
      '  timeout { exit 160 }',
      '  eof { exit 161 }',
      '}',
      `send -- [binary format H* ${utf8Hex(GUARDED_HOST_INPUT)}]`,
      'send -- "\\r"',
      'expect {',
      `  -exact ${JSON.stringify(GUARDED_HOST_REVIEW_TITLE)} {}`,
      '  timeout { exit 162 }',
      '  eof { exit 163 }',
      '}',
      `set guarded_output ${JSON.stringify(outputPath)}`,
      'if {[file exists $guarded_output]} { exit 167 }',
      'send -- "\\033"',
      'expect {',
      '  -exact "interrupted" {}',
      '  timeout { exit 164 }',
      '  eof { exit 165 }',
      '}',
      'if {[file exists $guarded_output]} { exit 171 }',
      `send -- [binary format H* ${utf8Hex('/con')}]`,
      'after 100',
      'send -- "\\t"',
      'after 100',
      `send -- [binary format H* ${utf8Hex(GUARDED_HOST_CONTINUATION_GUIDANCE)}]`,
      'send -- "\\r"',
      'expect {',
      '  -exact "Approval 1/1" {}',
      '  timeout { exit 172 }',
      '  eof { exit 173 }',
      '}',
      'if {[file exists $guarded_output]} { exit 174 }',
      'send -- "\\033\\[13u"',
      'expect {',
      `  -exact ${JSON.stringify(GUARDED_HOST_REPLY)} {}`,
      '  timeout { exit 175 }',
      '  eof { exit 176 }',
      '}',
      `send -- [binary format H* ${utf8Hex(attachmentPaste)}]`,
      'after 100',
      `send -- [binary format H* ${utf8Hex(ATTACHMENT_TOOL_INPUT)}]`,
      'send -- "\\r"',
      'expect {',
      `  -exact ${JSON.stringify(ATTACHMENT_TOOL_REPLY)} {}`,
      '  timeout { exit 168 }',
      '  eof { exit 169 }',
      '}',
      `send -- [binary format H* ${utf8Hex('/quit')}]`,
      'send -- "\\r"',
      'expect {',
      '  eof {}',
      '  timeout { exit 170 }',
      '}',
      'set result [wait]',
      'exit [lindex $result 3]',
    ].join('\n');
    tui = spawn('/usr/bin/expect', ['-c', expectScript], {
      cwd: workdir,
      env: {
        ...process.env,
        HOME: home,
        LOCAL_SERVER_PORT: String(host.port),
        TERM: 'xterm-256color',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    tui.stdout.setEncoding('utf8');
    tui.stderr.setEncoding('utf8');
    const stdout: string[] = [];
    const stderr: string[] = [];
    tui.stdout.on('data', (chunk: string) => stdout.push(chunk));
    tui.stderr.on('data', (chunk: string) => stderr.push(chunk));
    tuiExit = processExit(tui);

    const result = await withTimeout(
      tuiExit,
      10_000,
      'production TUI toolkit calls',
    );
    const output = decodeExpectBinaryOutput(stdout.join(''));
    assert.equal(
      result.code,
      0,
      [
        `TUI production-toolkit PTY failed: signal=${result.signal}`,
        stderr.join(''),
        output.slice(-4_000),
      ].join('\n'),
    );
    assert.equal(readFileSync(outputPath, 'utf8'), GUARDED_HOST_OUTPUT_CONTENT);
    const searchableOutput = compactTerminalObservation(output);
    assert.ok(searchableOutput.includes(
      compactTerminalObservation(GUARDED_HOST_TOOL_NAME),
    ));
    assert.ok(searchableOutput.includes(
      compactTerminalObservation(GUARDED_HOST_TOOL_OUTPUT),
    ));
    assert.ok(searchableOutput.includes(
      compactTerminalObservation(GUARDED_HOST_REPLY),
    ));
    assert.ok(searchableOutput.includes(
      compactTerminalObservation(GUARDED_HOST_CONTINUATION_GUIDANCE),
    ));
    assert.ok(searchableOutput.includes(
      compactTerminalObservation(ATTACHMENT_FILE_NAME),
    ));
    assert.ok(searchableOutput.includes(
      compactTerminalObservation(ATTACHMENT_TOOL_NAME),
    ));
    assert.ok(searchableOutput.includes(
      compactTerminalObservation(ATTACHMENT_TOOL_OUTPUT),
    ));
    assert.ok(searchableOutput.includes(
      compactTerminalObservation(ATTACHMENT_TOOL_REPLY),
    ));
    assert.ok(
      !searchableOutput.includes(compactTerminalObservation(attachmentPath)),
    );
    assertLastOrderedSubstrings(searchableOutput, [
      compactTerminalObservation(GUARDED_HOST_INPUT),
      compactTerminalObservation('interrupted'),
      compactTerminalObservation(GUARDED_HOST_CONTINUATION_GUIDANCE),
      compactTerminalObservation(GUARDED_HOST_TOOL_NAME),
      compactTerminalObservation(GUARDED_HOST_TOOL_OUTPUT),
      compactTerminalObservation(GUARDED_HOST_REPLY),
      compactTerminalObservation(ATTACHMENT_TOOL_INPUT),
      compactTerminalObservation(ATTACHMENT_TOOL_NAME),
      compactTerminalObservation(ATTACHMENT_TOOL_OUTPUT),
      compactTerminalObservation(ATTACHMENT_TOOL_REPLY),
    ], 'production toolkit terminal timeline');

    const hostPort = host.port;
    await stopHostProcess(host);
    host = null;
    host = await spawnHostProcess({
      port: hostPort,
      workdir,
      authToken: AUTH_TOKEN,
      fixture: 'toolkit',
    });
    controller = new TuiSessionController({
      connectionFactory: (handlers) => new LocalHostConnection(handlers, {
        port: hostPort,
        tokenProvider: () => AUTH_TOKEN,
      }),
      requestIdFactory: () => 'guarded-pty-checkpoint-snapshot',
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
        `user:${GUARDED_HOST_INPUT}`,
        `user:${GUARDED_HOST_CONTINUATION_GUIDANCE}`,
        `subagent:${GUARDED_HOST_TOOL_OUTPUT}`,
        `assistant:${GUARDED_HOST_REPLY}`,
        `user:${checkpointAttachmentText}`,
        `subagent:${ATTACHMENT_TOOL_OUTPUT}`,
        `assistant:${ATTACHMENT_TOOL_REPLY}`,
      ],
    );
    assert.ok(controller.getState().session.timeline.every((entry) => (
      entry.type !== 'message' || !entry.text.includes(attachmentPath)
    )));
    assert.equal(controller.getState().session.activeRun, null);
  } finally {
    controller?.stop();
    if (tui && tuiExit) {
      tui.stdin.end();
      await terminateProcess(tui, tuiExit, 'guarded TUI PTY cleanup');
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

function createPagerFixtureSource(params: {
  orderedValues: readonly string[];
  forbiddenValues: readonly string[];
  sentinelPath: string;
}) {
  return [
    "import { readFileSync, writeFileSync } from 'node:fs';",
    'const filePath = process.argv.at(-1);',
    "if (!filePath) throw new Error('missing pager file path');",
    "const content = readFileSync(filePath, 'utf8');",
    `const orderedValues = ${JSON.stringify(params.orderedValues)};`,
    `const forbiddenValues = ${JSON.stringify(params.forbiddenValues)};`,
    'let cursor = 0;',
    'for (const value of orderedValues) {',
    '  const index = content.indexOf(value, cursor);',
    '  if (index < 0) {',
    "    throw new Error('missing ordered transcript value: ' + JSON.stringify(value));",
    '  }',
    '  cursor = index + value.length;',
    '}',
    'for (const value of forbiddenValues) {',
    '  if (content.includes(value)) {',
    "    throw new Error('private transcript value leaked: ' + JSON.stringify(value));",
    '  }',
    '}',
    `writeFileSync(${JSON.stringify(params.sentinelPath)}, 'validated', 'utf8');`,
  ].join('\n');
}

function assertOrderedSubstrings(
  content: string,
  values: readonly string[],
  label: string,
) {
  let cursor = 0;
  for (const value of values) {
    const index = content.indexOf(value, cursor);
    assert.ok(
      index >= 0,
      `${label} omitted or reordered ${JSON.stringify(value)}`,
    );
    cursor = index + value.length;
  }
}

function assertLastOrderedSubstrings(
  content: string,
  values: readonly string[],
  label: string,
) {
  let cursor = -1;
  for (const value of values) {
    const index = content.lastIndexOf(value);
    assert.ok(
      index > cursor,
      `${label} did not settle ${JSON.stringify(value)} after offset ${cursor}`,
    );
    cursor = index;
  }
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
