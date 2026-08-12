/**
 * `@pinpawo/studio` —— Studio 编排核心。
 *
 * 本包只做编排:规划、调度、依赖、重试、run/task 状态机。
 * 持久化与知识库由 port 声明,宿主注入实现(见 `runQueuePort` / `wikiPort`),
 * 因此本包不碰文件系统。
 */

export { createStudio } from './createStudio';
export type { CreateStudioInput } from './createStudio';
export type {
  Studio,
  StudioDispatchInput,
  StudioDispatchResult,
  StudioEvent,
  StudioEventHandler,
  StudioEventInput,
  StudioPlugin,
  StudioPluginContext,
} from './studioContract';
export type { StudioPluginConfig } from './configSchema';

export { createStudioOrchestrator } from './createStudioOrchestrator';

export {
  createPlanToolkit,
  createPlanCapability,
} from './planCapability';
export type {
  CreatePlanToolkitOptions,
  StudioPlanPetListItem,
} from './planCapability';

export {
  petLocalConfigSchema,
  resolveStudio,
  studioLocalConfigSchema,
} from './configSchema';
export type {
  PetLocalConfig,
  ResolvedStudio,
  StudioLocalConfig,
} from './configSchema';

export * from './types';
export * from './petAgentTypes';

/* ─────────────── Ports:宿主注入实现 ─────────────── */

export {
  InMemoryStudioRunQueueStore,
  // 快照归一化 helper —— 供 toolkit 层的持久化实现复用,避免各实现
  // 各写一套恢复语义。
  OPEN_RUN_STATUSES,
  cloneSnapshot,
  recoverSnapshot,
  runFromSnapshot,
  snapshotFromRun,
  sortSnapshots,
} from './runQueuePort';
export type {
  StudioRunQueueStore,
  StudioRunQueueStoreRecoveryOptions,
  StudioRunQueueStoreState,
} from './runQueuePort';

export {
  createNoopWikiCurator,
  noopWikiSkeletonInitializer,
} from './wikiPort';
export type {
  StudioWikiAccess,
  StudioWikiTaskSource,
  WikiCurateInput,
  WikiCurateResult,
  WikiCurator,
  WikiSkeletonInitializer,
} from './wikiPort';

/* ─────────────── Due-run 调度 ─────────────── */

export * from './dueRunContract';
export * from './dueRunScheduler';
