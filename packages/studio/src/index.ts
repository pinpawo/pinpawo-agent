/**
 * `@pinpawo/studio` —— Studio 编排核心。
 *
 * 本包只做编排:规划、调度、依赖、重试、run/task 状态机。
 * 持久化与知识库由 port 声明,宿主注入实现(见 `runQueuePort` / `wikiPort`),
 * 因此本包不碰文件系统。
 */

export { createStudioOrchestrator } from './createStudioOrchestrator';
export { createPetAgentRuntime } from './createPetAgentRuntime';
export type { PetAgentRuntimeConfig } from './createPetAgentRuntime';

export {
  createPlanToolkit,
  createPlanCapability,
} from './planCapability';

export * from './types';
export * from './petAgentTypes';

/* ─────────────── Ports:宿主注入实现 ─────────────── */

export { InMemoryStudioRunQueueStore } from './runQueuePort';
export type {
  StudioRunQueueStore,
  StudioRunQueueStoreRecoveryOptions,
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
