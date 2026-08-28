import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { test } from 'node:test';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

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

test('SQLite task service starts one selected ready or blocked task explicitly', async (t) => {
  const service = await createService(':memory:');
  t.after(() => service.close());

  const prerequisite = await service.createTask({ assigneeId: 'writer', brief: 'draft' });
  const dependent = await service.createTask({
    assigneeId: 'reviewer',
    brief: 'review',
    dependsOn: [prerequisite.task.taskId],
  });
  await assert.rejects(
    () => service.claimReadyTask(dependent.task.taskId),
    /waiting for dependency/,
  );
  await service.claimReadyTask(prerequisite.task.taskId);
  await service.completeTask(prerequisite.task.taskId, 'draft ready');
  assert.equal((await service.claimReadyTask(dependent.task.taskId)).task.status, 'doing');
  await service.blockTask(dependent.task.taskId, 'review service unavailable');
  const restarted = await service.claimReadyTask(dependent.task.taskId);
  assert.equal(restarted.task.status, 'doing');
  assert.equal(restarted.task.note, undefined);
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

test('schema v2 migration removes the obsolete continuation column', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'pinpawo-kanban-v2-'));
  const databasePath = path.join(root, 'kanban.sqlite');
  const legacy = new DatabaseSync(databasePath);
  legacy.exec(`
    CREATE TABLE kanban_tasks (
      task_id TEXT PRIMARY KEY,
      assignee_id TEXT NOT NULL,
      brief TEXT NOT NULL,
      status TEXT NOT NULL,
      note TEXT,
      continuation_json TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    PRAGMA user_version = 2;
  `);
  legacy.close();

  const service = await createService(databasePath);
  await service.close();

  const migrated = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const columns = migrated.prepare('PRAGMA table_info(kanban_tasks)').all() as Array<{
      name: string;
    }>;
    const version = migrated.prepare('PRAGMA user_version').get() as { user_version: number };
    assert.equal(version.user_version, 3);
    assert.equal(columns.some(({ name }) => name === 'continuation_json'), false);
  } finally {
    migrated.close();
  }
});
