import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  buildCurrentTimeSnapshot,
  getCurrentTimeTool,
  getBlockedShellReason,
  getShellConfirmationRisk,
  hasBlockedOutputRedirection,
  normalizeShellActionInput,
  runShellTool,
  truncateShellOutput,
} from './toolkits/local/shellTools';
import { createBashToolkit } from './toolkits/local';

test('get_current_time returns current time details for a requested timezone', async () => {
  assert.deepEqual(
    buildCurrentTimeSnapshot(new Date('2026-06-23T02:30:00.000Z'), 'Asia/Shanghai'),
    {
      iso: '2026-06-23T02:30:00.000Z',
      timezone: 'Asia/Shanghai',
      localTime: '2026-06-23 10:30:00',
      unixMs: 1782181800000,
      unixSeconds: 1782181800,
    },
  );

  const parsed = JSON.parse(String(await getCurrentTimeTool.invoke({
    timezone: 'Asia/Shanghai',
  }))) as {
    iso?: string;
    timezone?: string;
    localTime?: string;
    unixMs?: number;
    unixSeconds?: number;
  };
  assert.equal(parsed.timezone, 'Asia/Shanghai');
  assert.equal(typeof parsed.iso, 'string');
  assert.equal(typeof parsed.localTime, 'string');
  assert.equal(typeof parsed.unixMs, 'number');
  assert.equal(typeof parsed.unixSeconds, 'number');
});

test('bash toolkit exposes get_current_time without command review', () => {
  const toolkit = createBashToolkit();

  assert.equal(Array.isArray(toolkit.tools), true);
  assert.equal(
    Array.isArray(toolkit.tools) && toolkit.tools.some((item) => item.name === 'get_current_time'),
    true,
  );
  assert.ok(toolkit.operations?.get_current_time);
  assert.equal(toolkit.policy?.toolReview?.get_current_time, undefined);
});

test('shell policy blocks output redirection write commands', () => {
  assert.equal(hasBlockedOutputRedirection('echo ok > out.txt'), true);
  assert.equal(hasBlockedOutputRedirection('echo ok 2>&1'), false);
  assert.equal(hasBlockedOutputRedirection('grep -r foo . 2>/dev/null'), false);
  assert.equal(hasBlockedOutputRedirection('noisy-tool >/dev/null 2>&1'), false);
  assert.equal(hasBlockedOutputRedirection('echo ok 2>/dev/null > out.txt'), true);
  assert.match(
    getBlockedShellReason('echo ok > out.txt') ?? '',
    /write_file/,
  );
});

test('shell policy marks risky commands for review', () => {
  assert.match(
    getShellConfirmationRisk('git commit -m test') ?? '',
    /git/,
  );
  assert.equal(getShellConfirmationRisk('printf ok'), null);
});

test('shell review policy reviews configured command execution', async () => {
  const toolkit = createBashToolkit();
  const policy = toolkit.policy?.toolReview?.run_shell;
  assert.ok(policy);

  const review = await policy.request({
    models: {} as never,
    actor: {} as never,
    messages: [],
    toolkitName: 'bash',
    toolName: 'run_shell',
    input: { command: 'pwd' },
    operation: toolkit.operations?.run_shell,
    reviewCapabilities: {
      humanReview: true,
      sessionAuthorization: true,
    },
  });
  assert.equal(review && 'schemaVersion' in review ? review.view.title : null, '执行命令');
  assert.deepEqual(
    review && 'schemaVersion' in review ? review.options.map((option) => option.id) : [],
    ['approve', 'approve-and-authorize-thread', 'reject', 'respond'],
  );
});

test('normalizeShellActionInput trims commands and expands home cwd', () => {
  assert.deepEqual(
    normalizeShellActionInput({ command: ' printf ok ', cwd: '~' }),
    {
      command: 'printf ok',
      cwd: homedir(),
    },
  );
});

test('runShellTool executes safe commands and rejects shell write fallbacks', async () => {
  assert.equal(
    await runShellTool.invoke({ command: 'printf ok' }),
    'ok',
  );

  assert.match(
    String(await runShellTool.invoke({ command: 'cat > file.txt' })),
    /write_file/,
  );
});

test('runShellTool relies on toolkit review instead of a second interface gate', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'pinpawo-shell-review-'));
  const file = join(dir, 'generated.tmp');
  writeFileSync(file, 'generated', 'utf-8');
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  assert.equal(await runShellTool.invoke({ command: `rm ${file}` }), '(no output)');
  assert.equal(existsSync(file), false);
});

test('runShellTool separates stderr and reports exit codes', async () => {
  assert.equal(
    await runShellTool.invoke({ command: 'printf out; printf err 1>&2' }),
    'out\n--- stderr ---\nerr',
  );

  assert.match(
    String(await runShellTool.invoke({ command: 'printf boom 1>&2; exit 3' })),
    /^Error \(exit 3\):\nboom/,
  );
});

test('runShellTool truncates stdout larger than the old 64KB buffer limit', async () => {
  const output = String(await runShellTool.invoke({
    command: 'node -e "process.stdout.write(\'x\'.repeat(70 * 1024))"',
  }));

  assert.doesNotMatch(output, /ENOBUFS/);
  assert.match(output, /^x+/);
  assert.match(output, /\[\.\.\. truncated \d+ chars \.\.\.\]/);
});

test('runShellTool times out long-running commands', async () => {
  const output = String(await runShellTool.invoke({
    command: 'sleep 5',
    timeoutSeconds: 1,
  }));
  assert.match(output, /timed out after 1s/);
});

test('truncateShellOutput keeps head and tail with a marker', () => {
  const long = 'a'.repeat(50) + 'b'.repeat(50);
  const truncated = truncateShellOutput(long, 40);
  assert.match(truncated, /^a+\n\[\.\.\. truncated 60 chars \.\.\.\]\nb+$/);
  assert.equal(truncateShellOutput('short', 40), 'short');
});
