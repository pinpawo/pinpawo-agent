/**
 * `@pinpawo/studio` — independent resident Studio Host and its runtime
 * contracts. Optional modules contribute policy and tools through explicit
 * injection; this package never imports a concrete module.
 */

export { createStudio } from './createStudio';
export type { CreateStudioInput } from './createStudio';
export type {
  Studio,
  StudioDispatchGateChange,
  StudioDispatchGateHandler,
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

/* ─────────────── Host/runtime layer ─────────────── */

export { StudioHost } from './host/StudioHost';
export type { StudioHostOptions } from './host/StudioHost';
export { buildStudio, StudioNotConfiguredError } from './host/buildStudio';
export type {
  BuildStudioInput,
  BuildStudioResult,
  ResolvedStudioModule,
  StudioModuleResolver,
} from './host/buildStudio';
export { createPetAgentRuntime } from './host/createPetAgentRuntime';
export type { PetAgentRuntimeConfig } from './host/createPetAgentRuntime';
export {
  StudioRequestHandler,
  createStudioPeerHandlers,
} from './transport/StudioRequestHandler';
export {
  startStudioStdioTransport,
  startStudioWebSocketTransport,
} from './transport/startStudioTransport';
export type { StudioTransportInput } from './transport/startStudioTransport';
export {
  startStudioHostStdio,
  startStudioHostWebSocket,
} from './startStudioHost';
export type {
  RunningStudioHost,
  StartStudioHostOptions,
} from './startStudioHost';
