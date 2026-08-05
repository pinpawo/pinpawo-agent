import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { test } from 'node:test';
import {
  MAX_ACTIVE_PROCESSES,
  ProcessRegistry,
  ProcessRegistryError,
  type ManagedProcessOwner,
} from './processRegistry';
import type { ShellRunHandle } from './processExecutor';
import {
  isProcessGroupAlive,
  posixProcessExecutor,
  runShellCommand,
} from './processTree';

const CWD = process.cwd();

const OWNER: ManagedProcessOwner = {
  threadId: 'thread-1',
  runId: 'run-1',
  delegationId: 'delegation-1',
};

const OTHER_OWNER: ManagedProcessOwner = {
  threadId: 'thread-1',
  runId: 'run-2',
  delegationId: 'delegation-2',
};

// POSIX executor integration: these run real sh commands and probe with
// pgrep/pkill. Registry logic that does not need an OS is covered by the
// fake-executor suite in processExecutor.test.ts.
const isWindows = process.platform === 'win32';
async function yieldedHandle(command: string): Promise<ShellRunHandle> {
  const outcome = await runShellCommand({
    command,
    cwd: CWD,
    timeoutMs: 150,
    maxOutputChars: 4096,
    yieldOnTimeout: true,
  });
  assert.equal(outcome.status, 'yielded', `expected ${command} to yield`);
  if (outcome.status !== 'yielded') throw new Error('unreachable');
  return outcome.handle;
}

function register(registry: ProcessRegistry, handle: ShellRunHandle, owner = OWNER) {
  return registry.register({ handle, owner, command: 'test', cwd: CWD });
}

test('registers a yielded process and reports it as running', { skip: isWindows }, async () => {
  const registry = new ProcessRegistry(posixProcessExecutor);
  const record = register(registry, await yieldedHandle('sleep 2'));

  assert.equal(record.status, 'running');
  assert.ok(record.processId);
  assert.equal(registry.list(OWNER).length, 1);

  await registry.stopAll(200);
});

test('drain returns only output produced since the previous drain', { skip: isWindows }, async () => {
  const registry = new ProcessRegistry(posixProcessExecutor);
  const handle = await yieldedHandle('echo first; sleep 0.4; echo second; sleep 2');
  const { processId } = register(registry, handle);

  const first = await registry.drain(processId, OWNER);
  assert.match(first.stdout, /first/);

  await new Promise((r) => setTimeout(r, 600));
  const second = await registry.drain(processId, OWNER);
  assert.match(second.stdout, /second/);
  assert.doesNotMatch(second.stdout, /first/, 'drained output must not repeat');

  const third = await registry.drain(processId, OWNER);
  assert.equal(third.stdout, '', 'nothing new to drain');

  await registry.stopAll(200);
});

test('output captured before the handover reaches the owner', { skip: isWindows }, async () => {
  const registry = new ProcessRegistry(posixProcessExecutor);
  // `early` is printed before the yield, so it is only in handle.stdout.
  const handle = await yieldedHandle('echo early; sleep 2');
  const { processId } = register(registry, handle);

  const drained = await registry.drain(processId, OWNER);
  assert.match(drained.stdout, /early/);

  await registry.stopAll(200);
});

test('wait resolves on exit and reports the exit code', { skip: isWindows }, async () => {
  const registry = new ProcessRegistry(posixProcessExecutor);
  const { processId } = register(registry, await yieldedHandle('sleep 0.4; exit 6'));

  const result = await registry.wait(processId, OWNER, 5_000);
  assert.equal(result.process.status, 'exited');
  assert.equal(result.process.exitCode, 6);
});

test('wait returns the running state when its own timeout elapses first', { skip: isWindows }, async () => {
  const registry = new ProcessRegistry(posixProcessExecutor);
  const { processId } = register(registry, await yieldedHandle('sleep 3'));

  const started = Date.now();
  const result = await registry.wait(processId, OWNER, 300);
  const elapsed = Date.now() - started;

  assert.equal(result.process.status, 'running');
  assert.ok(elapsed < 2_000, `wait must not block for the full command (${elapsed.toString()}ms)`);

  await registry.stopAll(200);
});

test('terminate stops the process and records the outcome', { skip: isWindows }, async () => {
  const registry = new ProcessRegistry(posixProcessExecutor);
  const { processId } = register(registry, await yieldedHandle('sleep 5'));

  const record = await registry.terminate(processId, OWNER, 200);
  assert.equal(record.status, 'terminated');
  assert.ok(record.exitedAt);
});

test('another execution cannot touch a process it did not start', { skip: isWindows }, async () => {
  const registry = new ProcessRegistry(posixProcessExecutor);
  const { processId } = register(registry, await yieldedHandle('sleep 2'));

  for (const operation of [
    () => registry.drain(processId, OTHER_OWNER),
    () => registry.wait(processId, OTHER_OWNER, 100),
    () => registry.terminate(processId, OTHER_OWNER),
  ]) {
    await assert.rejects(
      operation,
      (err: unknown) => err instanceof ProcessRegistryError && err.code === 'not_owner',
    );
  }

  assert.deepEqual(registry.list(OTHER_OWNER), []);
  await registry.stopAll(200);
});

test('adopting an already finished process reports it as finished', { skip: isWindows }, async () => {
  const registry = new ProcessRegistry(posixProcessExecutor);
  const handle = await yieldedHandle('echo before; sleep 0.2; echo after; exit 3');
  // The process exits in the gap between yielding and being adopted.
  await handle.wait();

  const record = register(registry, handle);
  assert.equal(record.status, 'exited', 'must not claim a finished process is running');

  const drained = await registry.drain(record.processId, OWNER);
  assert.match(drained.stdout, /before/);
  assert.match(drained.stdout, /after/, 'output produced before adoption is not lost');
});

test('an unknown process id is reported as such', { skip: isWindows }, async () => {
  const registry = new ProcessRegistry(posixProcessExecutor);
  await assert.rejects(
    () => registry.drain('does-not-exist', OWNER),
    (err: unknown) => err instanceof ProcessRegistryError && err.code === 'unknown_process',
  );
});

test('refuses to register beyond the concurrency cap', { skip: isWindows }, async () => {
  const registry = new ProcessRegistry(posixProcessExecutor);
  const handles: ShellRunHandle[] = [];
  for (let i = 0; i < MAX_ACTIVE_PROCESSES; i += 1) {
    const handle = await yieldedHandle('sleep 5');
    handles.push(handle);
    register(registry, handle);
  }

  const overflow = await yieldedHandle('sleep 5');
  handles.push(overflow);
  assert.throws(
    () => register(registry, overflow),
    (err: unknown) => err instanceof ProcessRegistryError && err.code === 'too_many_processes',
  );

  await registry.stopAll(200);
  overflow.terminate(200);
  await overflow.wait();
});

test('an exited process frees its slot', { skip: isWindows }, async () => {
  const registry = new ProcessRegistry(posixProcessExecutor);
  const { processId } = register(registry, await yieldedHandle('sleep 0.3'));
  await registry.wait(processId, OWNER, 5_000);

  // The cap counts running processes, so a finished one must not hold a slot.
  for (let i = 0; i < MAX_ACTIVE_PROCESSES; i += 1) {
    register(registry, await yieldedHandle('sleep 5'));
  }
  await registry.stopAll(200);
});

test('concurrent drains never deliver the same output twice', { skip: isWindows }, async () => {
  const registry = new ProcessRegistry(posixProcessExecutor);
  const handle = await yieldedHandle('echo alpha; sleep 2');
  const { processId } = register(registry, handle);

  const [a, b] = await Promise.all([
    registry.drain(processId, OWNER),
    registry.drain(processId, OWNER),
  ]);
  const combined = a.stdout + b.stdout;
  assert.equal(
    (combined.match(/alpha/g) ?? []).length,
    1,
    'serialized drains must not double-report',
  );

  await registry.stopAll(200);
});

test('a drain racing an exit still yields the final output', { skip: isWindows }, async () => {
  const registry = new ProcessRegistry(posixProcessExecutor);
  const handle = await yieldedHandle('sleep 0.3; echo last');
  const { processId } = register(registry, handle);

  const [waited] = await Promise.all([
    registry.wait(processId, OWNER, 5_000),
    registry.drain(processId, OWNER),
  ]);
  const later = await registry.drain(processId, OWNER);

  assert.match(waited.stdout + later.stdout, /last/);
});

test('stopAll terminates everything still running', { skip: isWindows }, async () => {
  const registry = new ProcessRegistry(posixProcessExecutor);
  const marker = `pinpawo-registry-stop-${Date.now().toString()}`;
  const handle = await yieldedHandle(
    `node -e "process.title='${marker}'; setTimeout(() => {}, 10000)"`,
  );
  register(registry, handle);

  await registry.stopAll(200);
  await new Promise((r) => setTimeout(r, 300));

  const alive = execSync(`pgrep -f ${JSON.stringify(marker)} || true`).toString().trim();
  execSync(`pkill -9 -f ${JSON.stringify(marker)} || true`);
  assert.equal(alive, '', 'shutdown must not strand processes');
  assert.equal(registry.size, 0);
});

test('tracks a process group that outlived its command', { skip: isWindows }, async () => {
  const registry = new ProcessRegistry(posixProcessExecutor);
  const marker = `pinpawo-registry-orphan-${Date.now().toString()}`;
  // The command exits cleanly but leaves a background child behind, the
  // `npm run dev &` shape.
  const outcome = await runShellCommand({
    command:
      `node -e "process.title='${marker}'; setInterval(() => {}, 1000)" >/dev/null 2>&1 & echo started`,
    cwd: CWD,
    timeoutMs: 5_000,
    maxOutputChars: 1024,
  });
  assert.equal(outcome.status, 'exited');
  if (outcome.status !== 'exited') return;

  assert.ok(outcome.pid, 'exited runs must report their process group');
  assert.equal(registry.trackOrphanGroup(outcome.pid), true);

  await registry.stopAll(200);
  await new Promise((r) => setTimeout(r, 400));

  const alive = execSync(`pgrep -f ${JSON.stringify(marker)} || true`).toString().trim();
  execSync(`pkill -9 -f ${JSON.stringify(marker)} || true`);
  assert.equal(alive, '', 'shutdown must clean up a surviving process group');
});

test('does not signal an orphan group that has since died', { skip: isWindows }, async () => {
  const registry = new ProcessRegistry(posixProcessExecutor);
  const marker = `pinpawo-registry-dead-${Date.now().toString()}`;
  const outcome = await runShellCommand({
    command:
      `node -e "process.title='${marker}'; setTimeout(() => {}, 400)" >/dev/null 2>&1 & echo started`,
    cwd: CWD,
    timeoutMs: 5_000,
    maxOutputChars: 1024,
  });
  assert.equal(outcome.status, 'exited');
  if (outcome.status !== 'exited' || !outcome.pid) return;

  assert.equal(registry.trackOrphanGroup(outcome.pid), true);
  // Let the background child finish on its own; the group id may be recycled
  // by then, so shutdown must not fire blindly at it.
  await new Promise((r) => setTimeout(r, 700));
  await registry.stopAll(200);
});

test('does not track a group that left nothing behind', { skip: isWindows }, async () => {
  const registry = new ProcessRegistry(posixProcessExecutor);
  const outcome = await runShellCommand({
    command: 'echo done',
    cwd: CWD,
    timeoutMs: 5_000,
    maxOutputChars: 1024,
  });
  assert.equal(outcome.status, 'exited');
  if (outcome.status !== 'exited') return;
  assert.ok(outcome.pid);
  assert.equal(registry.trackOrphanGroup(outcome.pid), false);
});

test('isProcessGroupAlive reports a finished group as gone', { skip: isWindows }, () => {
  // A pid this large is not in use; the group cannot be alive.
  assert.equal(isProcessGroupAlive(0x7fff_fffe), false);
});
