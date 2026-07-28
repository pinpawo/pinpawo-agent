import assert from 'node:assert/strict';
import {
  spawn,
  type ChildProcessWithoutNullStreams,
} from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import {
  processExit,
  terminateProcess,
  withTimeout,
} from './support/localHostProcessHarness';

const LOCAL_AGENT_ENTRY = fileURLToPath(
  new URL('../../local-agent/src/index.ts', import.meta.url),
);
const TSX_BIN = fileURLToPath(
  new URL('../../../node_modules/.bin/tsx', import.meta.url),
);

test('public v2 QA entry drives the production waiting and timeline UI', {
  skip: process.platform !== 'darwin'
    ? 'macOS expect PTY smoke'
    : false,
  timeout: 25_000,
}, async () => {
  const expectScript = [
    'set timeout 10',
    'set stty_init "rows 28 columns 96"',
    [
      'spawn -noecho',
      JSON.stringify(TSX_BIN),
      JSON.stringify(LOCAL_AGENT_ENTRY),
      'tui',
      '--v2',
      '--qa',
    ].join(' '),
    'fconfigure $spawn_id -translation binary -encoding binary',
    'expect {',
    '  -exact "PinPawo QA" {}',
    '  timeout { exit 181 }',
    '  eof { exit 182 }',
    '}',
    `send -- [binary format H* ${utf8Hex('Manual QA 中文 🙂')}]`,
    'send -- "\\017"',
    'expect {',
    '  -exact "PinPawo QA is thinking" {}',
    '  timeout { exit 183 }',
    '  eof { exit 184 }',
    '}',
    'expect {',
    '  -exact "Inspect terminal behavior" {}',
    '  timeout { exit 185 }',
    '  eof { exit 186 }',
    '}',
    'expect {',
    '  -exact "Subagent rows remain distinct from tool operations." {}',
    '  timeout { exit 187 }',
    '  eof { exit 188 }',
    '}',
    'expect {',
    '  -exact "20,000/3,000" {}',
    '  timeout { exit 189 }',
    '  eof { exit 190 }',
    '}',
    `send -- [binary format H* ${utf8Hex('/quit')}]`,
    'send -- "\\017"',
    'expect {',
    '  eof {}',
    '  timeout { exit 191 }',
    '}',
    'set result [wait]',
    'exit [lindex $result 3]',
  ].join('\n');
  let tui: ChildProcessWithoutNullStreams | null = null;
  let exit: ReturnType<typeof processExit> | null = null;
  try {
    tui = spawn('/usr/bin/expect', ['-c', expectScript], {
      cwd: fileURLToPath(new URL('..', import.meta.url)),
      env: {
        ...process.env,
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
    exit = processExit(tui);
    let result;
    try {
      result = await withTimeout(
        exit,
        20_000,
        'deterministic QA TUI',
      );
    } catch (error) {
      assert.fail([
        error instanceof Error ? error.message : String(error),
        stderr.join(''),
        decodeExpectBinaryOutput(stdout.join('')).slice(-4_000),
      ].join('\n'));
    }
    assert.equal(
      result.code,
      0,
      [
        `QA TUI failed: signal=${result.signal}`,
        stderr.join(''),
        decodeExpectBinaryOutput(stdout.join('')).slice(-4_000),
      ].join('\n'),
    );
  } finally {
    if (tui && exit) {
      tui.stdin.end();
      await terminateProcess(tui, exit, 'QA TUI cleanup');
    }
  }
});

function utf8Hex(value: string) {
  return Buffer.from(value, 'utf8').toString('hex');
}

function decodeExpectBinaryOutput(value: string) {
  return Buffer.from(value, 'latin1').toString('utf8');
}
