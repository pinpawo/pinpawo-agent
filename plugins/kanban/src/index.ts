/** `@pinpawo-plugin/kanban` —— optional Studio Kanban Plugin. */

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
