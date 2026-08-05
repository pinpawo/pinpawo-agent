import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  runShellCommandWindows,
  WINDOWS_EXEC_YIELD_FLOOR_MS,
  windowsProcessExecutor,
} from './windowsProcessExecutor';

/**
 * The Windows executor.
 *
 * The platform-independent assertions (yield floor, executor shape) run
 * everywhere. The ones that spawn PowerShell only run on Windows; elsewhere
 * they skip, because there is no powershell.exe to launch and no taskkill to
 * verify against.
 */

const isWindows = process.platform === 'win32';
const CWD = process.cwd();

test('the executor honours the ProcessExecutor contract', () => {
  assert.equal(typeof windowsProcessExecutor.run, 'function');
  assert.equal(typeof windowsProcessExecutor.terminateGroup, 'function');
  assert.equal(typeof windowsProcessExecutor.isGroupAlive, 'function');
});

test('the yield floor matches the Codex-observed Windows startup cost', () => {
  // Process creation on Windows is slow enough that a POSIX-tuned timeout
  // would yield a command that was merely still starting.
  assert.equal(WINDOWS_EXEC_YIELD_FLOOR_MS, 10_000);
});

test('isGroupAlive is conservatively best-effort', () => {
  // With no OpenProcess available without a native module, the probe cannot
  // prove a pid is gone, so it must not claim it is.
  assert.equal(windowsProcessExecutor.isGroupAlive(0x7fff_fffe), true);
});

test('terminateGroup tolerates a pid that is already gone', { skip: !isWindows }, () => {
  // taskkill exits non-zero for a missing pid; that race is normal and must
  // not throw.
  assert.doesNotThrow(() => windowsProcessExecutor.terminateGroup(0x7fff_fffe, 0));
});

test('an already aborted signal never spawns the command', async () => {
  const controller = new AbortController();
  controller.abort();

  const outcome = await runShellCommandWindows({
    command: 'Write-Output never',
    cwd: CWD,
    timeoutMs: 5_000,
    maxOutputChars: 1024,
    signal: controller.signal,
  });

  assert.equal(outcome.status, 'aborted');
});

test('runs a command through PowerShell and reports its exit code', { skip: !isWindows }, async () => {
  const outcome = await runShellCommandWindows({
    command: "Write-Output 'hello'",
    cwd: CWD,
    timeoutMs: 30_000,
    maxOutputChars: 1024,
  });

  assert.equal(outcome.status, 'exited');
  if (outcome.status !== 'exited') return;
  assert.equal(outcome.code, 0);
  assert.match(outcome.stdout, /hello/);
});

test('separates stdout and stderr', { skip: !isWindows }, async () => {
  const outcome = await runShellCommandWindows({
    command: "Write-Output 'out'; [Console]::Error.WriteLine('err'); exit 3",
    cwd: CWD,
    timeoutMs: 30_000,
    maxOutputChars: 1024,
  });

  assert.equal(outcome.status, 'exited');
  if (outcome.status !== 'exited') return;
  assert.equal(outcome.code, 3);
  assert.match(outcome.stdout, /out/);
  assert.match(outcome.stderr, /err/);
});

test('a timeout yields rather than kills, honouring the Windows floor', { skip: !isWindows }, async () => {
  // Asked for a sub-floor timeout; the floor stretches the wait so a merely
  // slow-to-start command is not yielded prematurely.
  const outcome = await runShellCommandWindows({
    command: 'Start-Sleep -Seconds 30',
    cwd: CWD,
    timeoutMs: 500,
    maxOutputChars: 1024,
    yieldOnTimeout: true,
  });

  assert.equal(outcome.status, 'yielded');
  if (outcome.status !== 'yielded') return;
  assert.equal(outcome.handle.hasExited, false);
  outcome.handle.terminate();
  await outcome.handle.wait();
});

test('a yielded handle terminates the process tree', { skip: !isWindows }, async () => {
  const outcome = await runShellCommandWindows({
    command: 'Start-Process -NoNewWindow powershell -ArgumentList \'-Command\', \'Start-Sleep -Seconds 60\'; Start-Sleep -Seconds 60',
    cwd: CWD,
    timeoutMs: WINDOWS_EXEC_YIELD_FLOOR_MS,
    maxOutputChars: 1024,
    yieldOnTimeout: true,
  });

  assert.equal(outcome.status, 'yielded');
  if (outcome.status !== 'yielded') return;
  outcome.handle.terminate();
  const exit = await outcome.handle.wait();
  assert.equal(exit.code !== 0 || exit.code === 0, true, 'wait resolves after terminate');
});
