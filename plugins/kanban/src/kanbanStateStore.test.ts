import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { KanbanBoard } from './kanbanBoard';
import { createFileKanbanStateStore } from './kanbanStateStore';

test('file state store atomically round-trips a versioned Kanban snapshot', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'pinpawo-kanban-state-'));
  const stateFile = path.join(root, 'nested', 'kanban.json');
  const board = new KanbanBoard();
  const task = board.add({ petId: 'worker', brief: 'persist me' });
  board.markDispatched(task.taskId);
  board.wait(task.taskId, 'waiting for approval');

  const store = createFileKanbanStateStore(stateFile);
  await store.save(board.snapshot());

  assert.deepEqual(await store.load(), board.snapshot());
  assert.deepEqual(await readdir(path.dirname(stateFile)), ['kanban.json']);
  const persisted = JSON.parse(await readFile(stateFile, 'utf8')) as Record<string, unknown>;
  assert.equal(persisted.version, 1);
});

test('file state store treats a missing file as an empty initial state', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'pinpawo-kanban-state-'));
  const store = createFileKanbanStateStore(path.join(root, 'missing.json'));
  assert.equal(await store.load(), null);
});

test('file state store rejects relative paths and invalid persisted state', async () => {
  assert.throws(
    () => createFileKanbanStateStore('relative/kanban.json'),
    /must be absolute/,
  );

  const root = await mkdtemp(path.join(tmpdir(), 'pinpawo-kanban-state-'));
  const stateFile = path.join(root, 'kanban.json');
  const store = createFileKanbanStateStore(stateFile);
  await writeFile(stateFile, JSON.stringify({ version: 2, board: { tasks: [] } }), 'utf8');
  await assert.rejects(() => store.load(), /unsupported version 2/);

  await writeFile(stateFile, '{not-json', 'utf8');
  await assert.rejects(() => store.load(), /JSON parse failed/);
});
