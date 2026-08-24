import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { test } from 'node:test';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  KanbanTaskService,
  SqliteKanbanTaskRepository,
} from './kanbanTaskService';
import { migrateKanbanSnapshotToSqlite } from './migrateKanbanSnapshotToSqlite';

async function createService(databasePath: string): Promise<KanbanTaskService> {
  const service = new KanbanTaskService(new SqliteKanbanTaskRepository(databasePath));
  await service.init();
  return service;
}

test('SQLite task service commits tasks, dependencies, and history atomically', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'pinpawo-kanban-sqlite-'));
  const service = await createService(path.join(root, 'state', 'kanban.sqlite'));
  t.after(() => service.close());

  const first = await service.createTask({ assigneeId: 'writer', brief: 'draft' });
  const second = await service.createTask({
    assigneeId: 'editor',
    brief: 'review',
    dependsOn: [first.task.taskId],
  });

  assert.equal((await service.claimNextReadyTask())?.task.taskId, first.task.taskId);
  assert.equal(await service.claimNextReadyTask(), null);
  await service.completeTask(first.task.taskId, 'draft ready');
  assert.equal((await service.claimNextReadyTask())?.task.taskId, second.task.taskId);

  const snapshot = await service.readSnapshot();
  assert.deepEqual(snapshot.tasks.map((task) => ({
    assigneeId: task.assigneeId,
    status: task.status,
    deps: task.deps,
  })).sort((left, right) => left.assigneeId.localeCompare(right.assigneeId)), [
    { assigneeId: 'editor', status: 'doing', deps: [first.task.taskId] },
    { assigneeId: 'writer', status: 'done', deps: [] },
  ]);
  assert.equal(snapshot.lastEventSequence, 5);
  assert.deepEqual(
    (await service.listTaskEvents()).map((event) => event.eventType),
    ['created', 'created', 'claimed', 'completed', 'claimed'],
  );
});

test('SQLite task service rejects missing dependencies before creating a task', async (t) => {
  const service = await createService(':memory:');
  t.after(() => service.close());

  await assert.rejects(
    () => service.createTask({
      assigneeId: 'writer',
      brief: 'cannot start',
      dependsOn: ['missing-task'],
    }),
    /does not exist/,
  );
  assert.deepEqual((await service.readSnapshot()).tasks, []);
});

test('SQLite task service commits one claim when callers race for ready work', async (t) => {
  const service = await createService(':memory:');
  t.after(() => service.close());
  const task = await service.createTask({ assigneeId: 'worker', brief: 'claim once' });

  const claims = await Promise.all([
    service.claimNextReadyTask(),
    service.claimNextReadyTask(),
  ]);
  assert.equal(claims.filter(Boolean).length, 1);
  assert.equal(claims.find(Boolean)?.task.taskId, task.task.taskId);
  assert.equal((await service.getTask(task.task.taskId))?.status, 'doing');
});

test('SQLite task service persists waiting and blocked state transitions in history', async (t) => {
  const service = await createService(':memory:');
  t.after(() => service.close());
  const task = await service.createTask({ assigneeId: 'worker', brief: 'needs a decision' });
  await service.claimNextReadyTask();
  await service.waitTask(task.task.taskId, 'awaiting approval');
  await service.blockTask(task.task.taskId, 'approval rejected');

  assert.deepEqual(
    (await service.listTaskEvents()).map((event) => ({
      eventType: event.eventType,
      toStatus: event.toStatus,
    })),
    [
      { eventType: 'created', toStatus: 'todo' },
      { eventType: 'claimed', toStatus: 'doing' },
      { eventType: 'waiting', toStatus: 'waiting' },
      { eventType: 'blocked', toStatus: 'blocked' },
    ],
  );
});

test('SQLite task service persists an opaque continuation and clears it after completion', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'pinpawo-kanban-sqlite-'));
  const databasePath = path.join(root, 'kanban.sqlite');
  const firstProcess = await createService(databasePath);
  const task = await firstProcess.createTask({ assigneeId: 'worker', brief: 'needs continuation' });
  await firstProcess.claimNextReadyTask();
  await firstProcess.waitForContinuation(task.task.taskId, {
    continuationId: 'continuation-1',
    payload: { kind: 'example_interaction', prompt: 'Continue?' },
  });
  await firstProcess.close();

  const secondProcess = await createService(databasePath);
  t.after(() => secondProcess.close());
  assert.deepEqual((await secondProcess.getTask(task.task.taskId))?.continuation, {
    continuationId: 'continuation-1',
    payload: { kind: 'example_interaction', prompt: 'Continue?' },
  });
  await secondProcess.completeTask(task.task.taskId, 'continued');
  assert.equal((await secondProcess.getTask(task.task.taskId))?.continuation, undefined);
});

test('SQLite task service records interrupted work as a recovered block on restart', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'pinpawo-kanban-sqlite-'));
  const databasePath = path.join(root, 'kanban.sqlite');
  const firstProcess = await createService(databasePath);
  const task = await firstProcess.createTask({ assigneeId: 'worker', brief: 'external work' });
  await firstProcess.claimNextReadyTask();
  await firstProcess.close();

  const secondProcess = await createService(databasePath);
  t.after(() => secondProcess.close());
  const recovered = await secondProcess.getTask(task.task.taskId);
  assert.equal(recovered?.status, 'blocked');
  assert.equal(recovered?.note, 'interrupted by restart');
  assert.deepEqual(
    (await secondProcess.listTaskEvents()).map((event) => event.eventType),
    ['created', 'claimed', 'recovered'],
  );
});

test('legacy JSON migration preserves the source and recovers imported doing work', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'pinpawo-kanban-migration-'));
  const snapshotFile = path.join(root, 'kanban.json');
  const databaseFile = path.join(root, 'kanban.sqlite');
  const legacy = {
    version: 1,
    board: {
      tasks: [
        {
          taskId: 'task-done',
          petId: 'writer',
          brief: 'finished work',
          status: 'done',
          deps: [],
          note: 'ready',
          createdAt: '2026-08-23T00:00:00.000Z',
          updatedAt: '2026-08-23T00:01:00.000Z',
        },
        {
          taskId: 'task-running',
          petId: 'editor',
          brief: 'uncertain work',
          status: 'doing',
          deps: ['task-done'],
          createdAt: '2026-08-23T00:02:00.000Z',
          updatedAt: '2026-08-23T00:03:00.000Z',
        },
      ],
    },
  };
  await writeFile(snapshotFile, `${JSON.stringify(legacy)}\n`, 'utf8');

  await migrateKanbanSnapshotToSqlite({ snapshotFile, databaseFile });
  assert.equal(await readFile(snapshotFile, 'utf8'), `${JSON.stringify(legacy)}\n`);

  const service = await createService(databaseFile);
  t.after(() => service.close());
  assert.deepEqual(
    (await service.readSnapshot()).tasks.map((task) => ({
      taskId: task.taskId,
      assigneeId: task.assigneeId,
      status: task.status,
      note: task.note,
    })).sort((left, right) => left.taskId.localeCompare(right.taskId)),
    [
      { taskId: 'task-done', assigneeId: 'writer', status: 'done', note: 'ready' },
      { taskId: 'task-running', assigneeId: 'editor', status: 'blocked', note: 'interrupted by restart' },
    ],
  );
  assert.deepEqual(
    (await service.listTaskEvents()).map((event) => event.eventType),
    ['imported', 'imported', 'recovered'],
  );
  await assert.rejects(
    () => migrateKanbanSnapshotToSqlite({ snapshotFile, databaseFile }),
    /target is not empty/,
  );
});

test('a failing committed-event listener does not fail the persisted command', async (t) => {
  const service = await createService(':memory:');
  t.after(() => service.close());
  service.subscribe(() => { throw new Error('observer unavailable'); });

  const mutation = await service.createTask({ assigneeId: 'worker', brief: 'still committed' });
  assert.equal(mutation.task.status, 'todo');
  assert.equal((await service.getTask(mutation.task.taskId))?.brief, 'still committed');
});
