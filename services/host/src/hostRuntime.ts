/**
 * Local Host runtime building blocks shared by the Chat Host and other local
 * Host implementations.
 *
 * This surface owns local-machine assembly concerns such as model profiles,
 * capabilities, Toolkit runtimes, configuration, and checkpoints. It must not
 * import a concrete Host (Chat or Studio) or an optional Studio module.
 */
export { buildHostModels, resolveLlmGenerationReserveTokens } from './agent/agentModels';
export {
  createResidentPet,
  createResidentPetHost,
  createResidentPetInteraction,
  createResidentPetRuntime,
  createResidentPetSessions,
  PetSessionNotFoundError,
  PetSessionReviewRefusedError,
  ResidentPetCoordinator,
} from './residentPetHost';
export type {
  AgentSessionPeer,
  CreateResidentPetHostOptions,
  CreateResidentPetRuntimeOptions,
  PetDispatchLifecycleEvent,
  PetDispatchLifecycleState,
  PetDispatchMessage,
  PetDispatchPort,
  PetDispatchQueueSnapshot,
  PetDispatchQueueEntry,
  PetDispatchRequest,
  PetDispatchSettledState,
  PetDispatchState,
  PetSessionPort,
  PetSessionReviewRequest,
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
export { loadPetDocumentFile } from './config/petDocument';
export type {
  HostCapabilityAssemblyInitOptions,
  HostCapabilityAssemblyOptions,
} from './hostCapabilityAssembly';
export type { LoadedCapability, LoadedUserCapability } from './capabilityLoader';
export type { LocalModelProfileRegistry } from './config/llmConfig';
export {
  buildHostRuntimeConfig,
  resolveHostCheckpointPath,
} from './config/runtimeConfig';
export type { HostRuntimeConfig } from './config/runtimeConfig';
export type {
  HostToolkitInventoryStore,
  ToolkitDefinitionSource,
} from './toolkits/toolkitInventory';

export { resolveHostExecutionConfig } from './config/hostExecutionConfig';
export type { HostExecutionConfig } from './config/hostExecutionConfig';

export {
  loadPetConfigs,
  loadPetDocument,
  petConfigSchema,
  PET_DOCUMENT_FILE_NAME,
  resolvePetCapabilityDirectory,
  resolvePetDocumentPath,
} from './config/petConfig';
export type { PetConfig } from './config/petConfig';
export { isSafePetPathSegment } from './petId';

export { readPetInvocationContext } from './host/petInvocationContext';
export type { PetInvocationContext, PetInvocationScope } from './host/petInvocationContext';

export { allocatePetSessionId } from './session/tuiSessionRegistry';
