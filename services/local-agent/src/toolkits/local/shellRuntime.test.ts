import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { test } from 'node:test';
import type { ToolkitRuntimeExecutionScope } from '@pinpawo/pet-agent';
import { runShellCommand, type ShellRunHandle } from './processTree';
import { ShellRuntime } from './shellRuntime';

const CWD = process.cwd();

function scope(overrides: Partial<ToolkitRuntimeExecutionScope> = {}): ToolkitRuntimeExecutionScope {
  return {
    threadId: 'thread-1',
    runId: 'run-1',
    delegationId: 'delegation-1',
    workdir: CWD,
    ...overrides,
  };
}

async function yieldedHandle(command: string): Promise<ShellRunHandle> {
  const outcome = await runShellCommand({
    command,
    cwd: CWD,
    timeoutMs: 150,
    maxOutputChars: 4096,
    yieldOnTimeout: true,
  });
  assert.equal(outcome.status, 'yielded');
  if (outcome.status !== 'yielded') throw new Error('unreachable');
  return outcome.handle;
}

function alive(marker: string) {
  return execSync(`pgrep -f ${JSON.stringify(marker)} || true`).toString().trim();
}

test('resolve carries the execution identity into the binding', () => {
  const runtime = new ShellRuntime();
  runtime.start();

  const binding = runtime.resolve(scope());
  assert.deepEqual(binding.owner, {
    threadId: 'thread-1',
    runId: 'run-1',
    delegationId: 'delegation-1',
  });
  assert.equal(binding.registry, runtime.getRegistry());
});

test('every execution shares one registry', () => {
  const runtime = new ShellRuntime();
  runtime.start();

  const first = runtime.resolve(scope());
  const second = runtime.resolve(scope({ runId: 'run-2', delegationId: 'delegation-2' }));

  // Processes live on the root, so both bindings reach the same registry
  // while remaining separate owners.
  assert.equal(first.registry, second.registry);
  assert.notDeepEqual(first.owner, second.owner);
});

test('release leaves a running process alone', async () => {
  const runtime = new ShellRuntime();
  runtime.start();
  const marker = `pinpawo-runtime-release-${Date.now().toString()}`;
  const binding = runtime.resolve(scope());
  const handle = await yieldedHandle(
    `node -e "process.title='${marker}'; setTimeout(() => {}, 5000)"`,
  );
  binding.registry.register({
    handle,
    owner: binding.owner,
    command: 'long',
    cwd: CWD,
  });

  runtime.release();
  await new Promise((r) => setTimeout(r, 300));

  // The whole point of yielding: work handed off must outlive the execution
  // that started it.
  assert.notEqual(alive(marker), '', 'release must not terminate a yielded process');

  await runtime.stop(200);
  execSync(`pkill -9 -f ${JSON.stringify(marker)} || true`);
});

test('a process registered by one execution is still reachable after release', async () => {
  const runtime = new ShellRuntime();
  runtime.start();
  const binding = runtime.resolve(scope());
  const record = binding.registry.register({
    handle: await yieldedHandle('sleep 3'),
    owner: binding.owner,
    command: 'long',
    cwd: CWD,
  });

  runtime.release();

  // A later execution with the same identity resumes ownership, matching how
  // browser lets the same scope pick its page back up.
  const resumed = runtime.resolve(scope());
  const drained = await resumed.registry.drain(record.processId, resumed.owner);
  assert.equal(drained.process.processId, record.processId);

  await runtime.stop(200);
});

test('stop terminates everything the registry holds', async () => {
  const runtime = new ShellRuntime();
  runtime.start();
  const marker = `pinpawo-runtime-stop-${Date.now().toString()}`;
  const binding = runtime.resolve(scope());
  binding.registry.register({
    handle: await yieldedHandle(
      `node -e "process.title='${marker}'; setTimeout(() => {}, 10000)"`,
    ),
    owner: binding.owner,
    command: 'long',
    cwd: CWD,
  });

  await runtime.stop(200);
  await new Promise((r) => setTimeout(r, 300));

  const survivors = alive(marker);
  execSync(`pkill -9 -f ${JSON.stringify(marker)} || true`);
  assert.equal(survivors, '', 'host shutdown must not strand processes');
  assert.equal(runtime.getRegistry().size, 0);
});

test('stop is safe with nothing registered', async () => {
  const runtime = new ShellRuntime();
  runtime.start();
  await runtime.stop(200);
  assert.equal(runtime.getRegistry().size, 0);
});
