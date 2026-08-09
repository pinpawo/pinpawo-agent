import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  InMemoryStudioRunQueueStore,
  RECOVERED_RUNNING_REASON,
  recoverSnapshot,
} from './runQueuePort';
import { failedAttemptCount } from './types';
import type { StudioInvocation, StudioRunSnapshot } from './types';

function invocation(overrides: Partial<StudioInvocation> = {}): StudioInvocation {
  return {
    invocationId: 'inv-1',
    petId: 'worker',
    attempt: 0,
    status: 'running',
    startedAt: '2026-06-20T00:00:01.000Z',
    ...overrides,
  };
}

function snapshot(overrides: Partial<StudioRunSnapshot> = {}): StudioRunSnapshot {
  return {
    runId: 'run-1',
    conversationId: 'conv-1',
    userRequest: 'do work',
    status: 'running',
    createdAt: '2026-06-20T00:00:00.000Z',
    updatedAt: '2026-06-20T00:00:01.000Z',
    tasks: [{
      runId: 'run-1',
      conversationId: 'conv-1',
      taskId: 'task-1',
      taskIndex: 0,
      petId: 'worker',
      brief: 'work',
      acceptanceCriteria: [],
      deps: [],
      status: 'running',
      invocations: [invocation()],
      enqueuedAt: '2026-06-20T00:00:00.000Z',
      startedAt: '2026-06-20T00:00:01.000Z',
    }],
    ...overrides,
  };
}

const NOW = '2026-06-21T00:00:00.000Z';

test('recovery closes the in-flight invocation, not just its task', () => {
  // 进程已经没了,invocation 不可能还在跑。只改 task 会留下
  // task=failed / invocation=running 的矛盾快照。
  const recovered = recoverSnapshot(snapshot(), NOW);
  const task = recovered.tasks[0]!;

  assert.equal(task.status, 'failed');
  assert.equal(task.invocations[0]?.status, 'failed');
  assert.equal(task.invocations[0]?.finishedAt, NOW);
  assert.equal(task.invocations[0]?.errorMessage, RECOVERED_RUNNING_REASON);
});

test('a recovered in-flight attempt still consumes retry budget', () => {
  // 这是矛盾状态的实际代价:failedAttemptCount 只数 failed,
  // 卡在 running 的那次不计入,崩溃前烧掉的预算就被退回去了。
  const recovered = recoverSnapshot(snapshot(), NOW);

  assert.equal(failedAttemptCount(recovered.tasks[0]!), 1);
});

test('recovery closes stale invocations even when the task is not running', () => {
  // task 已经被判 failed,但它最后一次 invocation 仍是 running —— 这种
  // 组合在崩溃时机不巧时会出现,同样要收尾。
  const recovered = recoverSnapshot(
    snapshot({
      tasks: [{
        ...snapshot().tasks[0]!,
        status: 'failed',
        invocations: [
          invocation({ invocationId: 'inv-0', status: 'failed', attempt: 0 }),
          invocation({ invocationId: 'inv-1', status: 'running', attempt: 1 }),
        ],
      }],
    }),
    NOW,
  );
  const task = recovered.tasks[0]!;

  assert.deepEqual(task.invocations.map((item) => item.status), ['failed', 'failed']);
  assert.equal(failedAttemptCount(task), 2);
});

test('recovery preserves already-terminal invocations verbatim', () => {
  const original = invocation({
    status: 'succeeded',
    finishedAt: '2026-06-20T00:00:09.000Z',
  });
  const recovered = recoverSnapshot(
    snapshot({
      tasks: [{ ...snapshot().tasks[0]!, status: 'done', invocations: [original] }],
    }),
    NOW,
  );

  assert.deepEqual(recovered.tasks[0]?.invocations[0], original);
});

test('stored snapshots are isolated from later mutation of a read copy', () => {
  // 浅拷会让 store 内部的 invocations 数组被调用方 push,污染已持久化状态。
  const store = new InMemoryStudioRunQueueStore();
  store.save(snapshot());

  const readCopy = store.get('run-1');
  readCopy?.tasks[0]?.invocations.push(invocation({ invocationId: 'injected' }));

  assert.deepEqual(
    store.get('run-1')?.tasks[0]?.invocations.map((item) => item.invocationId),
    ['inv-1'],
  );
});
