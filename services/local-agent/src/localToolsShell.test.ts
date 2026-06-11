import assert from 'node:assert/strict';
import { homedir } from 'node:os';
import test from 'node:test';
import {
  getBlockedShellReason,
  getShellConfirmationRisk,
  hasBlockedOutputRedirection,
  normalizeShellActionInput,
  runShellTool,
  truncateShellOutput,
} from './toolkits/local/shellTools';

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
