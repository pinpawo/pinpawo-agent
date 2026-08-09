/**
 * `@pinpawo-toolkit/studio-kanban` —— Studio 看板的文件实现。
 *
 * 看板管两件事:**任务队列**(run/task 快照、due-run 记录)和**知识库**(wiki)。
 * 两者都是 `@pinpawo/studio` 声明的 port,本包提供落盘实现,由宿主注入。
 *
 * 换成 S3 / DB 实现时,编排核心不需要任何改动。
 */

/* ─────────────── 任务队列 ─────────────── */

export { FileStudioRunQueueStore } from './runQueueStore';
export { FileStudioDueRunStore } from './fileDueRunStore';

/* ─────────────── 知识库 ─────────────── */

export { createFileWikiAccess } from './wikiAccess';
export { createWikiReadToolkit } from './wikiReadToolkit';
export {
  createWikiReadCapability,
  WIKI_READ_CAPABILITY_NAME,
} from './wikiReadCapability';

export {
  createLLMWikiCurator,
  createSkeletonWikiCurator,
  ensureWikiSkeleton,
  defaultPromptProvider,
  fileReadPromptProvider,
  DEFAULT_CURATOR_PROMPT,
} from './wikiCurator';
export type {
  CuratorPromptProvider,
  LLMWikiCuratorConfig,
  LLMWikiCuratorStructuredOutputConfig,
} from './wikiCurator';
