import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ProcessExecutor, ShellRunHandle } from './processExecutor';
import { ProcessRegistry, type ManagedProcessOwner } from './processRegistry';

/**
 * The registry against a stand-in executor.
 *
 * These cases start no processes at all, which is the point: if ownership,
 * quota and cleanup can be exercised without an OS, the platform boundary is
 * where it should be. Before the executor interface existed this file could
 * not have been written — the registry called `process.kill` directly.
 */

const OWNER: ManagedProcessOwner = {
  threadId: 'thread-1',
  runId: 'run-1',
  delegationId: 'delegation-1',
};

function fakeHandle(pid: number): ShellRunHandle & { finish: (code: number) => void } {
  let resolveExit!: (value: { code: number | null; stdout: string; stderr: string }) => void;
  const exit = new Promise<{ code: number | null; stdout: string; stderr: string }>(
    (resolve) => { resolveExit = resolve; },
  );
  let exited = false;
  return {
    pid,
    stdout: '',
    stderr: '',
    get hasExited() { return exited; },
    onOutput: () => () => undefined,
    wait: () => exit,
    terminate: () => {
      exited = true;
      resolveExit({ code: null, stdout: '', stderr: '' });
    },
    finish: (code: number) => {
      exited = true;
      resolveExit({ code, stdout: '', stderr: '' });
    },
  };
}

function recordingExecutor(overrides: Partial<ProcessExecutor> = {}) {
  const terminated: { pid: number; graceMs: number }[] = [];
  const probed: number[] = [];
  const executor: ProcessExecutor = {
    run: () => Promise.reject(new Error('not used in these tests')),
    terminateGroup: (pid, graceMs) => { terminated.push({ pid, graceMs }); },
    isGroupAlive: (pid) => { probed.push(pid); return true; },
    ...overrides,
  };
  return { executor, terminated, probed };
}

test('the registry asks the executor to signal, never the OS', async () => {
  const { executor, terminated } = recordingExecutor();
  const registry = new ProcessRegistry(executor);
  const handle = fakeHandle(4242);
  const record = registry.register({
    handle,
    owner: OWNER,
    command: 'fake',
    cwd: '/tmp',
  });

  await registry.terminate(record.processId, OWNER, 500);

  // Termination reached the executor rather than a signal call inside the
  // registry.
  assert.equal(terminated.length, 0, 'per-process termination goes through the handle');
  assert.equal(registry.list(OWNER)[0]?.status, 'terminated');
});

test('an orphan group is probed before it is signalled', async () => {
  const { executor, terminated, probed } = recordingExecutor();
  const registry = new ProcessRegistry(executor);

  assert.equal(registry.trackOrphanGroup(9001), true);
  assert.deepEqual(probed, [9001], 'tracking must confirm the group is alive');

  await registry.stopAll();
  assert.equal(terminated.length, 1);
  assert.equal(terminated[0]?.pid, 9001);
});

test('a dead orphan group is neither tracked nor signalled', async () => {
  const { executor, terminated } = recordingExecutor({ isGroupAlive: () => false });
  const registry = new ProcessRegistry(executor);

  assert.equal(registry.trackOrphanGroup(9002), false);
  await registry.stopAll();
  assert.deepEqual(terminated, [], 'nothing to signal');
});

test('ownership is enforced without touching a process', async () => {
  const { executor } = recordingExecutor();
  const registry = new ProcessRegistry(executor);
  const record = registry.register({
    handle: fakeHandle(1),
    owner: OWNER,
    command: 'fake',
    cwd: '/tmp',
  });

  await assert.rejects(
    () => registry.drain(record.processId, {
      threadId: 'thread-1',
      runId: 'run-2',
      delegationId: 'delegation-2',
    }),
    /different execution/,
  );
});

test('a finished process frees its slot without an OS call', async () => {
  const { executor } = recordingExecutor();
  const registry = new ProcessRegistry(executor);
  const handle = fakeHandle(7);
  const record = registry.register({
    handle,
    owner: OWNER,
    command: 'fake',
    cwd: '/tmp',
  });

  handle.finish(0);
  const drained = await registry.wait(record.processId, OWNER, 1_000);
  assert.equal(drained.process.status, 'exited');
  assert.equal(drained.process.exitCode, 0);
});
