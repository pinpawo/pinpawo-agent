import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { InMemoryStudioRunQueueStore } from '@pinpawo/studio';
import { FileStudioRunQueueStore } from './runQueueStore';
import type { StudioRunSnapshot } from '@pinpawo/studio';

async function mkTempDir(prefix: string): Promise<string> {
  return await fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

function snapshot(overrides: Partial<StudioRunSnapshot> = {}): StudioRunSnapshot {
  return {
    runId: 'run-1',
    conversationId: 'conv-1',
    userRequest: 'make a thing',
    status: 'running',
    createdAt: '2026-06-20T00:00:00.000Z',
    updatedAt: '2026-06-20T00:00:01.000Z',
    tasks: [
      {
        runId: 'run-1',
        conversationId: 'conv-1',
        taskIndex: 1,
        petId: 'pet-b',
        brief: 'second',
        acceptanceCriteria: [],
        deps: [],
        status: 'queued',
        enqueuedAt: '2026-06-20T00:00:01.000Z',
      },
      {
        runId: 'run-1',
        conversationId: 'conv-1',
        taskIndex: 0,
        petId: 'pet-a',
        brief: 'first',
        acceptanceCriteria: ['done'],
        deps: [],
        status: 'done',
        petRunId: 'pet-run-1',
        enqueuedAt: '2026-06-20T00:00:00.000Z',
        startedAt: '2026-06-20T00:00:01.000Z',
        finishedAt: '2026-06-20T00:00:02.000Z',
      },
    ],
    ...overrides,
  };
}

test('in-memory Studio run queue store saves snapshots and sorts tasks by taskIndex', () => {
  const store = new InMemoryStudioRunQueueStore();

  const saved = store.save(snapshot());

  assert.deepEqual(saved.tasks.map((task) => task.taskIndex), [0, 1]);
  assert.deepEqual(store.get('run-1')?.tasks.map((task) => task.taskIndex), [0, 1]);
  assert.equal(store.list().length, 1);
});

test('file Studio run queue store restores persisted run and task snapshots', async () => {
  const root = await mkTempDir('studio-run-queue-store-');
  const storePath = path.join(root, 'studio-run-queue.json');

  const first = new FileStudioRunQueueStore({ filePath: storePath });
  first.save(snapshot());

  const reopened = new FileStudioRunQueueStore({ filePath: storePath });
  const restored = reopened.get('run-1');

  assert.equal(restored?.runId, 'run-1');
  assert.equal(restored?.status, 'running');
  assert.deepEqual(restored?.tasks.map((task) => task.taskIndex), [0, 1]);
  assert.equal(restored?.tasks[0]?.petRunId, 'pet-run-1');
});

test('Studio run queue recovery blocks open runs with previously running tasks', () => {
  const store = new InMemoryStudioRunQueueStore();
  store.save(snapshot({
    status: 'running',
    tasks: [
      {
        runId: 'run-1',
        conversationId: 'conv-1',
        taskIndex: 0,
        petId: 'pet-a',
        brief: 'in flight',
        acceptanceCriteria: [],
        deps: [],
        status: 'running',
        petRunId: 'pet-run-in-flight',
        enqueuedAt: '2026-06-20T00:00:00.000Z',
        startedAt: '2026-06-20T00:00:01.000Z',
      },
      {
        runId: 'run-1',
        conversationId: 'conv-1',
        taskIndex: 1,
        petId: 'pet-b',
        brief: 'still queued',
        acceptanceCriteria: [],
        deps: [],
        status: 'queued',
        enqueuedAt: '2026-06-20T00:00:02.000Z',
      },
    ],
  }));

  const recovered = store.recoverOpenRuns({ now: '2026-06-20T00:00:30.000Z' });

  assert.equal(recovered.length, 1);
  assert.equal(recovered[0]?.status, 'blocked');
  assert.equal(recovered[0]?.tasks[0]?.status, 'failed');
  assert.equal(recovered[0]?.tasks[0]?.errorMessage, 'recovered_running_task_requires_reconcile');
  assert.equal(recovered[0]?.tasks[1]?.status, 'queued');
  assert.equal(store.get('run-1')?.status, 'blocked');
});

test('Studio run queue recovery keeps blocked queued tasks without forcing terminal state', () => {
  const store = new InMemoryStudioRunQueueStore();
  store.save(snapshot({
    status: 'blocked',
    tasks: [
      {
        runId: 'run-1',
        conversationId: 'conv-1',
        taskIndex: 0,
        petId: 'pet-a',
        brief: 'waiting',
        acceptanceCriteria: [],
        deps: [],
        status: 'queued',
        enqueuedAt: '2026-06-20T00:00:00.000Z',
      },
    ],
  }));

  const recovered = store.recoverOpenRuns({ now: '2026-06-20T00:00:30.000Z' });

  assert.equal(recovered[0]?.status, 'blocked');
  assert.equal(recovered[0]?.tasks[0]?.status, 'queued');
});
