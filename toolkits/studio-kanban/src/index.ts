/** `@pinpawo-toolkit/studio-kanban` —— optional Studio Kanban Plugin. */

/* ─────────────── Studio 插件 ─────────────── */

export {
  createKanbanPlugin,
  createKanbanToolkit,
  KANBAN_TOOLKIT_NAME,
} from './kanbanPlugin';
export type { CreateKanbanPluginOptions, KanbanPlugin } from './kanbanPlugin';
export { KanbanBoard } from './kanbanBoard';
export type { KanbanTask, KanbanTaskStatus, KanbanBoardSnapshot } from './kanbanBoard';
export { createFileKanbanStateStore } from './kanbanStateStore';
export type { KanbanStateStore } from './kanbanStateStore';
