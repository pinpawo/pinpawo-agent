import assert from 'node:assert/strict';
import { homedir } from 'node:os';
import test from 'node:test';
import {
  getBlockedShellReason,
  getShellConfirmationRisk,
  hasBlockedOutputRedirection,
  normalizeShellActionInput,
  runShellTool,
} from './toolkits/local/shellTools';

test('shell policy blocks output redirection write commands', () => {
  assert.equal(hasBlockedOutputRedirection('echo ok > out.txt'), true);
  assert.equal(hasBlockedOutputRedirection('echo ok 2>&1'), false);
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
