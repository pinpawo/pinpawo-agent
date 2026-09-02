/**
 * Local Host runtime building blocks shared by the Chat Host and other local
 * Host implementations.
 *
 * This surface owns local-machine assembly concerns such as model profiles,
 * capabilities, Toolkit runtimes, configuration, and checkpoints. It must not
 * import a concrete Host (Chat or Studio) or an optional Studio module.
 */
export { buildLocalAgentModels, resolveLlmGenerationReserveTokens } from './agentModels';
export {
  createResidentPet,
  createResidentPetHost,
  createResidentPetInteraction,
  createResidentPetRuntime,
  ResidentPetCoordinator,
} from './residentPetHost';
export type {
  AgentSessionPeer,
  CreateResidentPetHostOptions,
  CreateResidentPetRuntimeOptions,
  PetDispatchLifecycleEvent,
  PetDispatchLifecycleState,
  PetDispatchPort,
  PetDispatchQueueSnapshot,
  PetDispatchRequest,
  PetDispatchSettledState,
  PetDispatchState,
  ResidentPet,
  ResidentPetCoordinatorOptions,
  ResidentPetHost,
  ResidentPetInteraction,
  ResidentPetRuntime,
} from './residentPetHost';
export { createExploreCapability } from './capabilities/explore/index';
export { loadCapabilityDirectory } from './capabilityLoader';
export { HostCapabilityCatalog } from './hostCapabilityCatalog';
export type {
  CapabilityCatalogSnapshot,
} from './hostCapabilityCatalog';
export { FileSaver } from './fileSaver';
export { HostCapabilityAssembly } from './hostCapabilityAssembly';
export type {
  HostCapabilityAssemblyInitOptions,
  HostCapabilityAssemblyOptions,
} from './hostCapabilityAssembly';
export type { LoadedCapability, LoadedUserCapability } from './capabilityLoader';
export type { LocalModelProfileRegistry } from './llmConfig';
export {
  buildLocalAgentRuntimeConfig,
  resolveHostCheckpointPath,
} from './runtimeConfig';
export type { LocalAgentRuntimeConfig } from './runtimeConfig';
export type {
  HostToolkitInventoryStore,
  ToolkitDefinitionSource,
} from './toolkits/toolkitInventory';
