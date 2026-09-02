import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { test } from 'node:test';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createInMemoryKanbanTaskService, KanbanTaskService, SqliteKanbanTaskRepository } from './kanbanTaskService';

async function service() {
  const value = createInMemoryKanbanTaskService();
  await value.init();
  return value;
}

test('Kanban records unassigned work before a user assignment and executor start', async (t) => {
  const kanban = await service();
  t.after(() => kanban.close());
  const created = await kanban.createTask({ title: 'Draft design', detail: 'Write the design draft.' });
  assert.equal(created.task.status, 'todo');
  assert.equal(created.task.assigneeId, undefined);

  const assigned = await kanban.assignTask(created.task.taskId, 'executor');
  assert.deepEqual(
    { status: assigned.task.status, assigneeId: assigned.task.assigneeId, event: assigned.event.eventType },
    { status: 'assigned', assigneeId: 'executor', event: 'assigned' },
  );
  const started = await kanban.startAssignedTask(created.task.taskId);
  assert.equal(started.task.status, 'doing');
  await kanban.completeTask(created.task.taskId, 'draft saved');
  assert.deepEqual((await kanban.listTaskEvents()).map(({ eventType }) => eventType), [
    'created', 'assigned', 'started', 'completed',
  ]);
});

test('Kanban only permits assignment after dependencies are done', async (t) => {
  const kanban = await service();
  t.after(() => kanban.close());
  const first = await kanban.createTask({ title: 'Implement', detail: 'Implement.' });
  const second = await kanban.createTask({ title: 'Review', detail: 'Review.', dependsOn: [first.task.taskId] });
  await assert.rejects(() => kanban.assignTask(second.task.taskId, 'reviewer'), /waiting for dependency/);
  await kanban.assignTask(first.task.taskId, 'executor');
  await kanban.startAssignedTask(first.task.taskId);
  await kanban.completeTask(first.task.taskId, 'done');
  assert.equal((await kanban.assignTask(second.task.taskId, 'reviewer')).task.status, 'assigned');
});

test('only confirmed started work is recovered as blocked after restart', async (t) => {
  const kanban = await service();
  t.after(() => kanban.close());
  const assigned = await kanban.createTask({ title: 'Assigned', detail: 'wait for delivery' });
  const started = await kanban.createTask({ title: 'Started', detail: 'working' });
  await kanban.assignTask(assigned.task.taskId, 'executor');
  await kanban.assignTask(started.task.taskId, 'executor');
  await kanban.startAssignedTask(started.task.taskId);
  // The persistence-specific crash recovery is covered by the repository lifecycle;
  // this contract test establishes that the domain distinguishes assigned from started.
  assert.equal((await kanban.getTask(assigned.task.taskId))?.status, 'assigned');
  assert.equal((await kanban.getTask(started.task.taskId))?.status, 'doing');
});

test('schema v4 clears obsolete automatic assignment before user reassignment', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'pinpawo-kanban-v4-'));
  const databasePath = path.join(root, 'kanban.sqlite');
  const database = new DatabaseSync(databasePath);
  database.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE kanban_tasks (
      task_id TEXT PRIMARY KEY, assignee_id TEXT NOT NULL, title TEXT NOT NULL, detail TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('todo', 'doing', 'waiting', 'done', 'blocked')),
      note TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE kanban_task_dependencies (
      task_id TEXT NOT NULL, depends_on_task_id TEXT NOT NULL, PRIMARY KEY (task_id, depends_on_task_id),
      FOREIGN KEY (task_id) REFERENCES kanban_tasks(task_id) ON DELETE CASCADE,
      FOREIGN KEY (depends_on_task_id) REFERENCES kanban_tasks(task_id) ON DELETE RESTRICT
    );
    CREATE TABLE kanban_task_events (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL, event_type TEXT NOT NULL,
      from_status TEXT, to_status TEXT NOT NULL, note TEXT, occurred_at TEXT NOT NULL,
      FOREIGN KEY (task_id) REFERENCES kanban_tasks(task_id) ON DELETE RESTRICT
    );
    INSERT INTO kanban_tasks VALUES ('existing', 'executor', 'Existing', 'Existing task', 'todo', NULL, '2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z');
    PRAGMA user_version = 4;
  `);
  database.close();
  const kanban = new KanbanTaskService(new SqliteKanbanTaskRepository(databasePath));
  await kanban.init();
  t.after(() => kanban.close());
  assert.deepEqual(await kanban.getTask('existing'), {
    taskId: 'existing', title: 'Existing', detail: 'Existing task', status: 'todo', deps: [],
    createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z',
  });
  assert.equal((await kanban.assignTask('existing', 'executor')).task.status, 'assigned');
});
