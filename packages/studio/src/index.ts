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
  StudioDispatchQueue,
  StudioEvent,
  StudioEventHandler,
  StudioEventInput,
  StudioPetSessions,
  StudioPlugin,
  StudioPluginContext,
  StudioPluginHookInstaller,
  StudioPluginHooks,
} from './studioContract';
export { StudioPetUnavailableError } from './studioContract';
export { createStudioStorage } from './storage/studioStorage';
export { StudioClients, StudioClientError } from './clients/studioClients';
export type { StudioClient } from './clients/studioClients';
export type { ClientKeyRow, ClientRow, ClientStore } from './clients/store/clientStore';
export { KyselyClientStore, clientMigrations, type ClientDatabase } from './clients/store/kysely';
export type {
  StudioMigrations,
  StudioPluginStorage,
  StudioStorage,
  StudioStorageConfig,
  StudioStorageDialect,
} from './storage/studioStorage';
export { parseStudioDispatchRequest, readStudioInvocation } from './studioInvocation';
export type { StudioInvocation, StudioWireDispatchRequest } from './studioInvocation';

export {
  resolveStudio,
  studioLocalConfigSchema,
} from './configSchema';
export type {
  ResolvedStudio,
  StudioLocalConfig,
  StudioPluginConfig,
  StudioStorageSettings,
} from './configSchema';

export * from './types';

/* ─────────────── Host/runtime layer ─────────────── */

export { StudioHost } from './host/StudioHost';
export type { StudioHostOptions } from './host/StudioHost';
export {
  buildStudio,
  resolveStudioHostConfig,
  resolveStudioStorage,
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
export {
  initStudioWorkdir,
} from './studioTemplate';
export type {
  InitStudioWorkdirOptions,
  InitStudioWorkdirResult,
} from './studioTemplate';
