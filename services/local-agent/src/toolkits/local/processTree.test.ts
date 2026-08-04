import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { test } from 'node:test';
import { runShellCommand } from './processTree';

const CWD = process.cwd();

function descendantsAlive(marker: string) {
  const found = execSync(`pgrep -f ${JSON.stringify(marker)} || true`)
    .toString()
    .trim();
  return found ? found.split('\n').filter(Boolean) : [];
}

function killMarker(marker: string) {
  execSync(`pkill -f ${JSON.stringify(marker)} || true`);
}

/**
 * A shell that forks and then waits, mirroring the `pnpm install` shape:
 * `/bin/sh` is the direct child, the real work is a grandchild.
 */
function forkingCommand(marker: string) {
  return `sleep 30 & echo ${marker}-child $!; wait`;
}

test('runs a bounded command and reports its exit code', async () => {
  const outcome = await runShellCommand({
    command: 'echo hello; exit 0',
    cwd: CWD,
    timeoutMs: 5_000,
    maxOutputChars: 1024,
  });
  assert.equal(outcome.status, 'exited');
  assert.equal(outcome.status === 'exited' ? outcome.code : null, 0);
  assert.match(outcome.status === 'exited' ? outcome.stdout : '', /hello/);
});

test('separates stdout and stderr', async () => {
  const outcome = await runShellCommand({
    command: 'echo out; echo err 1>&2; exit 3',
    cwd: CWD,
    timeoutMs: 5_000,
    maxOutputChars: 1024,
  });
  assert.equal(outcome.status, 'exited');
  if (outcome.status !== 'exited') return;
  assert.equal(outcome.code, 3);
  assert.match(outcome.stdout, /out/);
  assert.match(outcome.stderr, /err/);
});

test('timeout kills the whole process group, not just the shell', async () => {
  const marker = `pinpawo-tree-timeout-${Date.now().toString()}`;
  const outcome = await runShellCommand({
    command: forkingCommand(marker),
    cwd: CWD,
    timeoutMs: 400,
    maxOutputChars: 1024,
    killGraceMs: 200,
  });

  assert.equal(outcome.status, 'timeout');
  await new Promise((r) => setTimeout(r, 600));
  const survivors = descendantsAlive(marker);
  killMarker(marker);
  assert.deepEqual(survivors, [], 'no descendant may outlive the timeout');
});

test('abort kills the whole process group', async () => {
  const marker = `pinpawo-tree-abort-${Date.now().toString()}`;
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 300);

  const outcome = await runShellCommand({
    command: forkingCommand(marker),
    cwd: CWD,
    timeoutMs: 30_000,
    maxOutputChars: 1024,
    killGraceMs: 200,
    signal: controller.signal,
  });

  assert.equal(outcome.status, 'aborted');
  await new Promise((r) => setTimeout(r, 600));
  const survivors = descendantsAlive(marker);
  killMarker(marker);
  assert.deepEqual(survivors, [], 'no descendant may outlive the abort');
});

test('an already aborted signal never spawns the command', async () => {
  const marker = `pinpawo-tree-pre-${Date.now().toString()}`;
  const controller = new AbortController();
  controller.abort();

  const outcome = await runShellCommand({
    command: `echo ${marker}; sleep 5`,
    cwd: CWD,
    timeoutMs: 5_000,
    maxOutputChars: 1024,
    signal: controller.signal,
  });

  assert.equal(outcome.status, 'aborted');
  assert.equal(descendantsAlive(marker).length, 0);
});

test('distinguishes abort from timeout when both are possible', async () => {
  // The signal fires well before the timeout would; the outcome must say so,
  // because the two mean different things to the caller.
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 200);
  const outcome = await runShellCommand({
    command: 'sleep 10',
    cwd: CWD,
    timeoutMs: 9_000,
    maxOutputChars: 1024,
    killGraceMs: 200,
    signal: controller.signal,
  });
  assert.equal(outcome.status, 'aborted');
});

test('reports spawn failure for an unusable cwd', async () => {
  const outcome = await runShellCommand({
    command: 'echo nope',
    cwd: '/definitely/not/a/directory',
    timeoutMs: 5_000,
    maxOutputChars: 1024,
  });
  assert.equal(outcome.status, 'spawn_failed');
});

test('escalates to SIGKILL for a descendant that ignores SIGTERM', async () => {
  const marker = `pinpawo-tree-stubborn-${Date.now().toString()}`;
  const outcome = await runShellCommand({
    command: `node -e "process.title='${marker}'; process.on('SIGTERM', () => {}); setTimeout(() => {}, 30000)" & echo go; wait`,
    cwd: CWD,
    timeoutMs: 400,
    maxOutputChars: 1024,
    killGraceMs: 400,
  });

  assert.equal(outcome.status, 'timeout');
  await new Promise((r) => setTimeout(r, 800));
  const survivors = descendantsAlive(marker);
  execSync(`pkill -9 -f ${JSON.stringify(marker)} || true`);
  assert.deepEqual(survivors, [], 'SIGTERM-ignoring descendant must still be killed');
});

test('keeps output produced before a timeout', async () => {
  // The command still ran and said something; losing that would hide why it
  // was slow.
  const outcome = await runShellCommand({
    command: 'echo early-output; sleep 5',
    cwd: CWD,
    timeoutMs: 400,
    maxOutputChars: 1024,
    killGraceMs: 200,
  });
  assert.equal(outcome.status, 'timeout');
  assert.match(outcome.status === 'timeout' ? outcome.stdout : '', /early-output/);
});

test('caps each stream independently', async () => {
  const outcome = await runShellCommand({
    command: 'node -e "process.stdout.write(\'a\'.repeat(500)); process.stderr.write(\'b\'.repeat(500))"',
    cwd: CWD,
    timeoutMs: 10_000,
    maxOutputChars: 100,
  });
  assert.equal(outcome.status, 'exited');
  if (outcome.status !== 'exited') return;
  assert.equal(outcome.stdout.length, 100);
  assert.equal(outcome.stderr.length, 100);
});

test('bounds captured output', async () => {
  const outcome = await runShellCommand({
    command: 'node -e "process.stdout.write(\'x\'.repeat(5000))"',
    cwd: CWD,
    timeoutMs: 10_000,
    maxOutputChars: 100,
  });
  assert.equal(outcome.status, 'exited');
  assert.ok(
    (outcome.status === 'exited' ? outcome.stdout.length : 0) <= 100,
    'stdout must respect maxOutputChars',
  );
});
