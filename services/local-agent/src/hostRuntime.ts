/**
 * Local Host runtime building blocks shared by the Chat Host and other local
 * Host implementations.
 *
 * This surface owns local-machine assembly concerns such as model profiles,
 * capabilities, Toolkit runtimes, configuration, and checkpoints. It must not
 * import a concrete Host (Chat or Studio) or an optional Studio module.
 */
export { buildLocalAgentModels, resolveLlmGenerationReserveTokens } from './agentModels';
export { createExploreCapability } from './capabilities/explore/index';
export { FileSaver } from './fileSaver';
export { HostCapabilityAssembly } from './hostCapabilityAssembly';
export type { HostCapabilityAssemblyOptions } from './hostCapabilityAssembly';
export type { LoadedUserCapability } from './capabilityLoader';
export type { LocalModelProfileRegistry } from './llmConfig';
export {
  buildLocalAgentRuntimeConfig,
  resolveHostCheckpointPath,
} from './runtimeConfig';
export type { LocalAgentRuntimeConfig } from './runtimeConfig';
export type { HostToolkitInventoryStore } from './toolkits/toolkitInventory';
