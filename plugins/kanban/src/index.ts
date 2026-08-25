/** `@pinpawo-plugin/kanban` —— optional Studio Kanban Plugin. */

import path from 'node:path';
import type { StudioCliPluginEnvironment } from '@pinpawo/studio';
import { createKanbanPlugin as createKanbanPluginImpl } from './kanbanPlugin';

/* ─────────────── Studio 插件 ─────────────── */

export {
  createKanbanPlugin,
  createKanbanToolkit,
  KANBAN_TOOLKIT_NAME,
} from './kanbanPlugin';
export type { CreateKanbanPluginOptions, KanbanPlugin } from './kanbanPlugin';
export {
  createInMemoryKanbanTaskService,
  KanbanTaskService,
  SqliteKanbanTaskRepository,
} from './kanbanTaskService';
export type {
  CreateKanbanTaskInput,
  KanbanTask,
  KanbanTaskEvent,
  KanbanTaskMutation,
  KanbanTaskRepository,
  KanbanTaskSnapshot,
  KanbanTaskStatus,
} from './kanbanTaskService';
export { migrateKanbanSnapshotToSqlite } from './migrateKanbanSnapshotToSqlite';
export type { MigrateKanbanSnapshotToSqliteInput } from './migrateKanbanSnapshotToSqlite';

/** Explicit module identity consumed by the standalone Studio CLI loader. */
export const id = 'kanban';

/**
 * CLI factory. Database placement remains Kanban-owned; a relative path is
 * resolved from the configured Studio workdir rather than the CLI process cwd.
 */
export function createStudioPlugin(
  options: Record<string, unknown> | undefined,
  environment: StudioCliPluginEnvironment,
) {
  const databasePath = options?.databasePath;
  if (databasePath !== undefined && (typeof databasePath !== 'string' || !databasePath.trim())) {
    throw new Error('Kanban Plugin option "databasePath" must be a non-empty string when present.');
  }
  const unsupported = Object.keys(options ?? {}).filter((key) => key !== 'databasePath');
  if (unsupported.length > 0) {
    throw new Error(`Kanban Plugin does not support CLI option(s): ${unsupported.join(', ')}.`);
  }
  return createKanbanPluginImpl({
    ...(databasePath ? { databasePath: path.resolve(environment.workdir, databasePath) } : {}),
  });
}
