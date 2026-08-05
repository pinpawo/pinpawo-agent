import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { test } from 'node:test';
import { runShellCommand } from './processTree';

const CWD = process.cwd();

// These cases exercise the POSIX executor through sh, pgrep and pkill; the
// Windows implementation has its own suite in windowsProcessExecutor.test.ts.
const isWindows = process.platform === 'win32';

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

test('runs a bounded command and reports its exit code', { skip: isWindows }, async () => {
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

test('separates stdout and stderr', { skip: isWindows }, async () => {
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

test('timeout kills the whole process group, not just the shell', { skip: isWindows }, async () => {
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

test('abort kills the whole process group', { skip: isWindows }, async () => {
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

test('an already aborted signal never spawns the command', { skip: isWindows }, async () => {
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

test('distinguishes abort from timeout when both are possible', { skip: isWindows }, async () => {
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

test('reports spawn failure for an unusable cwd', { skip: isWindows }, async () => {
  const outcome = await runShellCommand({
    command: 'echo nope',
    cwd: '/definitely/not/a/directory',
    timeoutMs: 5_000,
    maxOutputChars: 1024,
  });
  assert.equal(outcome.status, 'spawn_failed');
});

test('escalates to SIGKILL for a descendant that ignores SIGTERM', { skip: isWindows }, async () => {
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

test('keeps output produced before a timeout', { skip: isWindows }, async () => {
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

test('caps each stream independently', { skip: isWindows }, async () => {
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

test('bounds captured output', { skip: isWindows }, async () => {
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

test('yieldOnTimeout hands back a handle instead of killing', { skip: isWindows }, async () => {
  const marker = `pinpawo-yield-${Date.now().toString()}`;
  const outcome = await runShellCommand({
    command: `node -e "process.title='${marker}'; setTimeout(() => {}, 4000)"`,
    cwd: CWD,
    timeoutMs: 300,
    maxOutputChars: 1024,
    yieldOnTimeout: true,
  });

  assert.equal(outcome.status, 'yielded');
  if (outcome.status !== 'yielded') return;
  assert.notDeepEqual(descendantsAlive(marker), [], 'process must survive the yield');

  outcome.handle.terminate(200);
  await outcome.handle.wait();
  killMarker(marker);
});

test('a yielded process survives cancellation of the call that started it', { skip: isWindows }, async () => {
  // The whole point of yielding: the run outlives the tool call, so that
  // call's abort must no longer reach it.
  const marker = `pinpawo-yield-abort-${Date.now().toString()}`;
  const controller = new AbortController();
  const outcome = await runShellCommand({
    command: `node -e "process.title='${marker}'; setTimeout(() => {}, 4000)"`,
    cwd: CWD,
    timeoutMs: 300,
    maxOutputChars: 1024,
    yieldOnTimeout: true,
    signal: controller.signal,
  });

  assert.equal(outcome.status, 'yielded');
  if (outcome.status !== 'yielded') return;

  controller.abort();
  await new Promise((r) => setTimeout(r, 500));
  const survivors = descendantsAlive(marker);

  outcome.handle.terminate(200);
  await outcome.handle.wait();
  killMarker(marker);
  assert.notDeepEqual(survivors, [], 'abort of the original call must not kill it');
});

test('a yielded handle reports the eventual exit code', { skip: isWindows }, async () => {
  const outcome = await runShellCommand({
    command: 'sleep 0.6; exit 7',
    cwd: CWD,
    timeoutMs: 200,
    maxOutputChars: 1024,
    yieldOnTimeout: true,
  });
  assert.equal(outcome.status, 'yielded');
  if (outcome.status !== 'yielded') return;
  assert.equal((await outcome.handle.wait()).code, 7);
});

test('a yielded handle keeps accumulating output', { skip: isWindows }, async () => {
  const outcome = await runShellCommand({
    command: 'echo first; sleep 0.5; echo second',
    cwd: CWD,
    timeoutMs: 250,
    maxOutputChars: 1024,
    yieldOnTimeout: true,
  });
  assert.equal(outcome.status, 'yielded');
  if (outcome.status !== 'yielded') return;
  assert.match(outcome.handle.stdout, /first/);
  assert.match((await outcome.handle.wait()).stdout, /second/);
});

test('onOutput streams post-yield chunks and can be unsubscribed', { skip: isWindows }, async () => {
  const outcome = await runShellCommand({
    command: 'echo one; sleep 0.3; echo two; sleep 0.3; echo three',
    cwd: CWD,
    timeoutMs: 200,
    maxOutputChars: 1024,
    yieldOnTimeout: true,
  });
  assert.equal(outcome.status, 'yielded');
  if (outcome.status !== 'yielded') return;

  const seen: string[] = [];
  const unsubscribe = outcome.handle.onOutput((_stream, chunk) => {
    seen.push(chunk.trim());
    unsubscribe();
  });
  await outcome.handle.wait();

  assert.equal(seen.length, 1, 'unsubscribe must stop further delivery');
});

test('a yielded handle releases its subscribers once the process exits', { skip: isWindows }, async () => {
  const outcome = await runShellCommand({
    command: 'sleep 0.4',
    cwd: CWD,
    timeoutMs: 200,
    maxOutputChars: 1024,
    yieldOnTimeout: true,
  });
  assert.equal(outcome.status, 'yielded');
  if (outcome.status !== 'yielded') return;

  let delivered = 0;
  outcome.handle.onOutput(() => { delivered += 1; });
  await outcome.handle.wait();
  assert.equal(delivered, 0, 'no output was produced after the yield');
});

test('terminating a yielded handle repeatedly is safe', { skip: isWindows }, async () => {
  const outcome = await runShellCommand({
    command: 'sleep 5',
    cwd: CWD,
    timeoutMs: 200,
    maxOutputChars: 1024,
    yieldOnTimeout: true,
  });
  assert.equal(outcome.status, 'yielded');
  if (outcome.status !== 'yielded') return;

  outcome.handle.terminate(200);
  outcome.handle.terminate(200);
  await outcome.handle.wait();
  // Terminating after exit must not throw either.
  outcome.handle.terminate(200);
});

test('yieldOnTimeout leaves short commands unchanged', { skip: isWindows }, async () => {
  const outcome = await runShellCommand({
    command: 'echo quick',
    cwd: CWD,
    timeoutMs: 5_000,
    maxOutputChars: 1024,
    yieldOnTimeout: true,
  });
  assert.equal(outcome.status, 'exited');
  assert.match(outcome.status === 'exited' ? outcome.stdout : '', /quick/);
});

test('abort still terminates a run that has not yielded', { skip: isWindows }, async () => {
  const marker = `pinpawo-yield-preabort-${Date.now().toString()}`;
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 200);

  const outcome = await runShellCommand({
    command: forkingCommand(marker),
    cwd: CWD,
    timeoutMs: 30_000,
    maxOutputChars: 1024,
    killGraceMs: 200,
    signal: controller.signal,
    yieldOnTimeout: true,
  });

  assert.equal(outcome.status, 'aborted');
  await new Promise((r) => setTimeout(r, 500));
  const survivors = descendantsAlive(marker);
  killMarker(marker);
  assert.deepEqual(survivors, [], 'pre-yield abort must still kill the group');
});
