import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ShellRunHandle } from './processExecutor';
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
  clientId: 'client', toolkitName: 'bash', taskId: 'task',
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

test('termination uses the owned handle rather than a numeric PID', async () => {
  const registry = new ProcessRegistry();
  const handle = fakeHandle(4242);
  const record = registry.register({ handle, owner: OWNER, command: 'fake', cwd: '/tmp' });
  await registry.terminate(record.processId, OWNER, 500);
  assert.equal(handle.hasExited, true);
  assert.equal(registry.list(OWNER)[0]?.status, 'terminated');
});

test('disconnect never signals an already finished process', async () => {
  const registry = new ProcessRegistry();
  const handle = fakeHandle(9001);
  const record = registry.register({ handle, owner: OWNER, command: 'finished', cwd: '/tmp' });
  handle.finish(0);
  await registry.wait(record.processId, OWNER, 1000);
  handle.terminate = () => { throw new Error('stale handle termination'); };
  await registry.stopClient(OWNER.clientId);
  assert.equal(registry.size, 0);
});

test('ownership is enforced without touching a process', async () => {
  const registry = new ProcessRegistry();
  const record = registry.register({
    handle: fakeHandle(1),
    owner: OWNER,
    command: 'fake',
    cwd: '/tmp',
  });

  await assert.rejects(
    () => registry.drain(record.processId, {
      clientId: 'client', toolkitName: 'bash', taskId: 'task',
      threadId: 'thread-1',
      runId: 'run-2',
      delegationId: 'delegation-2',
    }),
    /different execution/,
  );
});

test('a finished process frees its slot without an OS call', async () => {
  const registry = new ProcessRegistry();
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
