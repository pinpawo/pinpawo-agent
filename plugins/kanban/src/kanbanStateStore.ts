import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';

import type {
  KanbanBoardSnapshot,
  KanbanTask,
  KanbanTaskStatus,
} from './kanbanBoard';

const KANBAN_STATE_VERSION = 1;
const TASK_STATUSES = new Set<KanbanTaskStatus>([
  'todo',
  'doing',
  'waiting',
  'done',
  'blocked',
]);

export type KanbanStateStore = {
  load: () => Promise<KanbanBoardSnapshot | null>;
  save: (snapshot: KanbanBoardSnapshot) => Promise<void>;
};

type PersistedKanbanState = {
  version: typeof KANBAN_STATE_VERSION;
  board: KanbanBoardSnapshot;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function invalidState(filePath: string, detail: string): Error {
  return new Error(`Invalid Kanban state at ${filePath}: ${detail}`);
}

function readRequiredString(
  record: Record<string, unknown>,
  field: keyof KanbanTask,
  filePath: string,
  index: number,
): string {
  const value = record[field];
  if (typeof value !== 'string' || value.length === 0) {
    throw invalidState(filePath, `tasks[${index.toString()}].${field} must be a non-empty string`);
  }
  return value;
}

function parseTask(value: unknown, filePath: string, index: number): KanbanTask {
  if (!isRecord(value)) {
    throw invalidState(filePath, `tasks[${index.toString()}] must be an object`);
  }
  const status = value.status;
  if (typeof status !== 'string' || !TASK_STATUSES.has(status as KanbanTaskStatus)) {
    throw invalidState(filePath, `tasks[${index.toString()}].status is not supported`);
  }
  if (!Array.isArray(value.deps) || value.deps.some((dependency) => (
    typeof dependency !== 'string' || dependency.length === 0
  ))) {
    throw invalidState(filePath, `tasks[${index.toString()}].deps must contain non-empty strings`);
  }
  if (value.note !== undefined && typeof value.note !== 'string') {
    throw invalidState(filePath, `tasks[${index.toString()}].note must be a string`);
  }
  return {
    taskId: readRequiredString(value, 'taskId', filePath, index),
    petId: readRequiredString(value, 'petId', filePath, index),
    brief: readRequiredString(value, 'brief', filePath, index),
    status: status as KanbanTaskStatus,
    deps: [...value.deps] as string[],
    ...(value.note !== undefined ? { note: value.note } : {}),
    createdAt: readRequiredString(value, 'createdAt', filePath, index),
    updatedAt: readRequiredString(value, 'updatedAt', filePath, index),
  };
}

function parsePersistedState(value: unknown, filePath: string): KanbanBoardSnapshot {
  if (!isRecord(value)) throw invalidState(filePath, 'root must be an object');
  if (value.version !== KANBAN_STATE_VERSION) {
    throw invalidState(filePath, `unsupported version ${String(value.version)}`);
  }
  if (!isRecord(value.board) || !Array.isArray(value.board.tasks)) {
    throw invalidState(filePath, 'board.tasks must be an array');
  }
  const tasks = value.board.tasks.map((task, index) => parseTask(task, filePath, index));
  const taskIds = new Set(tasks.map(({ taskId }) => taskId));
  if (taskIds.size !== tasks.length) {
    throw invalidState(filePath, 'taskId values must be unique');
  }
  return { tasks };
}

async function removeTemporaryFile(filePath: string): Promise<void> {
  try {
    await unlink(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

/** Create one versioned, atomic file store owned entirely by the Kanban Plugin. */
export function createFileKanbanStateStore(filePath: string): KanbanStateStore {
  if (!path.isAbsolute(filePath)) {
    throw new Error('Kanban state file path must be absolute.');
  }
  return {
    load: async () => {
      let raw: string;
      try {
        raw = await readFile(filePath, 'utf8');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw error;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch (error) {
        throw invalidState(
          filePath,
          `JSON parse failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      return parsePersistedState(parsed, filePath);
    },
    save: async (snapshot) => {
      const state: PersistedKanbanState = {
        version: KANBAN_STATE_VERSION,
        board: snapshot,
      };
      const directory = path.dirname(filePath);
      const temporaryPath = path.join(
        directory,
        `.${path.basename(filePath)}.${process.pid.toString()}.${randomUUID()}.tmp`,
      );
      await mkdir(directory, { recursive: true, mode: 0o700 });
      try {
        await writeFile(
          temporaryPath,
          `${JSON.stringify(state, null, 2)}\n`,
          { encoding: 'utf8', flag: 'wx', mode: 0o600 },
        );
        await rename(temporaryPath, filePath);
      } catch (error) {
        await removeTemporaryFile(temporaryPath).catch(() => undefined);
        throw error;
      }
    },
  };
}
