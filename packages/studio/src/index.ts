/**
 * `@pinpawo/studio` — independent resident Studio Host and its runtime
 * contracts. Plugins are selected through explicit Host injection; this
 * package never imports a concrete Plugin implementation.
 */

export { createStudio } from './createStudio';
export type { CreateStudioInput } from './createStudio';
export type {
  Studio,
  StudioDispatchReceipt,
  StudioDispatchRequest,
  StudioEvent,
  StudioEventHandler,
  StudioEventInput,
  StudioPlugin,
  StudioPluginContext,
  StudioPluginHookInstaller,
  StudioPluginHooks,
} from './studioContract';
export { parseStudioDispatchRequest } from './studioInvocation';

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

/* ─────────────── Host/runtime layer ─────────────── */

export { StudioHost } from './host/StudioHost';
export type { StudioHostOptions } from './host/StudioHost';
export {
  buildStudio,
  resolveStudioHostConfig,
  StudioNotConfiguredError,
} from './host/buildStudio';
export type {
  BuildStudioInput,
  BuildStudioResult,
  ResolvedStudioHostConfig,
  ResolveStudioHostConfigInput,
  StudioPluginResolver,
} from './host/buildStudio';
export { createInstalledStudioPluginResolver } from './installedPluginResolver';
export type {
  CreateInstalledStudioPluginResolverOptions,
  InstalledStudioPluginEnvironment,
} from './installedPluginResolver';
export { startStudioHost } from './startStudioHost';
export type {
  RunningStudioHost,
  StartStudioHostOptions,
} from './startStudioHost';
export { runStudioHostProcess } from './studioHostProcess';
export type {
  StudioHostProcessDependencies,
  StudioHostProcessOptions,
} from './studioHostProcess';
export { initStudioKickstart } from './studioTemplate';
export type {
  InitStudioKickstartOptions,
  InitStudioKickstartResult,
} from './studioTemplate';
