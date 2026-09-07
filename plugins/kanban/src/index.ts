/** `@pinpawo-plugin/kanban` —— optional Studio Kanban Plugin. */

/* ─────────────── Studio 插件 ─────────────── */

export {
  createKanbanPlugin,
  createKanbanExecutionToolkit,
  createKanbanObservationToolkit,
  createKanbanPlanningToolkit,
  createKanbanToolkit,
  createStudioPlugin,
  KANBAN_EXECUTION_TOOLKIT_NAME,
  KANBAN_OBSERVATION_TOOLKIT_NAME,
  KANBAN_PLANNING_TOOLKIT_NAME,
  KANBAN_TOOLKIT_NAME,
} from './kanbanPlugin';
export type {
  CreateKanbanPluginOptions,
  InstalledKanbanPluginEnvironment,
  KanbanPlugin,
} from './kanbanPlugin';
export {
  createInMemoryKanbanTaskService,
  KanbanTaskService,
  SqliteKanbanTaskRepository,
} from './kanbanTaskService';
export type {
  CreateKanbanTaskInput,
  KanbanTask,
  KanbanTaskDeletion,
  KanbanTaskEvent,
  KanbanTaskMutation,
  KanbanTaskRepository,
  KanbanTaskRelationship,
  KanbanTaskSnapshot,
  KanbanTaskStatus,
} from './kanbanTaskService';
export { migrateKanbanSnapshotToSqlite } from './migrateKanbanSnapshotToSqlite';
export type { MigrateKanbanSnapshotToSqliteInput } from './migrateKanbanSnapshotToSqlite';
