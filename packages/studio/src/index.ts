/**
 * `@pinpawo/studio` —— Studio 插板。
 *
 * 它提供两个方向的通道,不提供任何管理策略:
 *
 *     plugin ──event────> studio ──dispatch──> pet
 *
 * 任务队列、依赖、进度、调度时机、重试全部属于插件 —— studio 不认识它们,
 * 也不持有由 event 推导出的任何状态。因此本包不碰文件系统。
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

export {
  petLocalConfigSchema,
  resolveStudio,
  studioLocalConfigSchema,
} from './configSchema';
export type {
  PetLocalConfig,
  ResolvedStudio,
  StudioLocalConfig,
  StudioPluginConfig,
} from './configSchema';

export * from './types';
export * from './petAgentTypes';

/* ─────────────── Wiki port:宿主注入实现 ─────────────── */

export type { StudioWikiAccess } from './wikiPort';
