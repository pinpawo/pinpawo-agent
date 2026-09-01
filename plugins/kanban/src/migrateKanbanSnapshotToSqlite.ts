import { readFile } from 'node:fs/promises';
import path from 'node:path';

import {
  SqliteKanbanTaskRepository,
  type KanbanTaskStatus,
  type LegacyKanbanTask,
} from './kanbanTaskService';

const LEGACY_SNAPSHOT_VERSION = 1;
const TASK_STATUSES = new Set<KanbanTaskStatus>([
  'todo', 'doing', 'waiting', 'done', 'blocked',
]);

export type MigrateKanbanSnapshotToSqliteInput = {
  snapshotFile: string;
  databaseFile: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function invalidSnapshot(filePath: string, detail: string): Error {
  return new Error(`Invalid legacy Kanban snapshot at ${filePath}: ${detail}`);
}

function readString(
  record: Record<string, unknown>,
  field: string,
  filePath: string,
  index: number,
): string {
  const value = record[field];
  if (typeof value !== 'string' || !value.trim()) {
    throw invalidSnapshot(filePath, `board.tasks[${index.toString()}].${field} must be a non-empty string`);
  }
  return value;
}

function parseTask(value: unknown, filePath: string, index: number): LegacyKanbanTask {
  if (!isRecord(value)) throw invalidSnapshot(filePath, `board.tasks[${index.toString()}] must be an object`);
  const status = value.status;
  if (typeof status !== 'string' || !TASK_STATUSES.has(status as KanbanTaskStatus)) {
    throw invalidSnapshot(filePath, `board.tasks[${index.toString()}].status is not supported`);
  }
  if (!Array.isArray(value.deps) || value.deps.some((dependency) => (
    typeof dependency !== 'string' || !dependency.trim()
  ))) {
    throw invalidSnapshot(filePath, `board.tasks[${index.toString()}].deps must contain non-empty strings`);
  }
  if (value.note !== undefined && typeof value.note !== 'string') {
    throw invalidSnapshot(filePath, `board.tasks[${index.toString()}].note must be a string`);
  }
  const brief = readString(value, 'brief', filePath, index);
  const firstLine = brief.split(/\r?\n/).map((line) => line.trim()).find(Boolean) ?? brief.trim();
  return {
    taskId: readString(value, 'taskId', filePath, index),
    assigneeId: readString(value, 'petId', filePath, index),
    title: firstLine.length <= 160 ? firstLine : `${firstLine.slice(0, 159).trimEnd()}…`,
    detail: brief,
    status: status as KanbanTaskStatus,
    deps: [...value.deps] as string[],
    ...(value.note === undefined ? {} : { note: value.note }),
    createdAt: readString(value, 'createdAt', filePath, index),
    updatedAt: readString(value, 'updatedAt', filePath, index),
  };
}

async function loadLegacyTasks(snapshotFile: string): Promise<LegacyKanbanTask[]> {
  let raw: string;
  try {
    raw = await readFile(snapshotFile, 'utf8');
  } catch (error) {
    throw new Error(
      `Could not read legacy Kanban snapshot ${snapshotFile}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw invalidSnapshot(
      snapshotFile,
      `JSON parse failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!isRecord(parsed) || parsed.version !== LEGACY_SNAPSHOT_VERSION || !isRecord(parsed.board)) {
    throw invalidSnapshot(snapshotFile, 'expected version 1 with a board object');
  }
  if (!Array.isArray(parsed.board.tasks)) {
    throw invalidSnapshot(snapshotFile, 'board.tasks must be an array');
  }
  return parsed.board.tasks.map((task, index) => parseTask(task, snapshotFile, index));
}

/**
 * One-way explicit migration for the former file-backed Kanban state store.
 * The source file is never changed; the caller may archive it after verification.
 */
export async function migrateKanbanSnapshotToSqlite(
  input: MigrateKanbanSnapshotToSqliteInput,
): Promise<void> {
  if (!path.isAbsolute(input.snapshotFile) || !path.isAbsolute(input.databaseFile)) {
    throw new Error('Kanban snapshot migration paths must be absolute.');
  }
  if (path.resolve(input.snapshotFile) === path.resolve(input.databaseFile)) {
    throw new Error('Kanban snapshot migration source and destination must differ.');
  }
  const tasks = await loadLegacyTasks(input.snapshotFile);
  const repository = new SqliteKanbanTaskRepository(input.databaseFile);
  try {
    await repository.init();
    await repository.importLegacyTasks(tasks);
    await repository.recoverInterruptedTasks();
  } finally {
    await repository.close();
  }
}
