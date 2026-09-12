import type {
  BuiltinGlobalReviewPolicyMode,
  CapabilityArtifactStore,
  PetDocument,
  ToolkitRuntimeManager,
} from '@pinpawo/pet-agent';
import type { BaseCheckpointSaver } from '@langchain/langgraph-checkpoint';
import type { ToolAuthorizationSafetyLevel } from '@pinpawo/agent-contracts';
import type { HostCapabilityCatalog } from './hostCapabilityCatalog';
import type { LocalModelProfileRegistry } from './config/llmConfig';
import type { HostExecutionConfig } from './config/hostExecutionConfig';
import type { ServerMode } from './config/serverMode';
import {
  type HostToolkitInventorySnapshot,
  HostToolkitInventoryStore,
} from './toolkits/toolkitInventory';

export type CapabilityCatalogReader = Pick<
  HostCapabilityCatalog,
  'getSnapshot'
>;

export type ServerDeps = HostExecutionConfig & {
  /** Local-agent interaction mode; resident Pet adapters reuse the Chat semantics. */
  serverMode: ServerMode;
  petId: string;
  petName?: string;
  modelProfiles: LocalModelProfileRegistry;
  /**
   * Composition Host 持有的 conversation checkpointer。Chat Host 与 Studio Host
   * 使用独立 root，但都通过同一 local-agent session stack 注入。FileSaver 仍提供
   * store-wide filesystem writer lock，保护同一 root 被意外多进程打开时的
   * read-modify-write 与 GC。
   *
   * Missing adapters use the explicit runtimeConfig.tuiCheckpointPath. Composing
   * production Hosts supply their owned adapter so reads, writes and leases agree.
   */
  chatCheckpointer?: BaseCheckpointSaver;
  toolkitInventory: HostToolkitInventoryStore;
  toolkitRuntimeManager?: ToolkitRuntimeManager;
  /** Host-owned Capability catalog; Chat consumes its configured snapshot. */
  capabilityCatalog: CapabilityCatalogReader;
  /** Capability preloaded by this resident Pet's entry Supervisor. */
  defaultCapabilityName?: string;
  /** Host-loaded root document shared by every model role of this resident Pet. */
  petDocument?: PetDocument;
  /**
   * Required: every production Host supplies one, and an execution cannot be
   * assembled without it. It was optional here while consumers re-checked it
   * at runtime; the type now says what the code always assumed.
   */
  capabilityArtifactStore: CapabilityArtifactStore;
};

/**
 * Narrow contracts, one per domain.
 *
 * `ServerDeps` is the Host's full assembly. It is not a bus: a consumer
 * declares the fields it actually reads, per module-boundaries §二
 * 「消费者声明自身需要的字段」. These aliases give those declarations a name
 * so the dependency direction is visible in signatures rather than implied by
 * a shared bag.
 */

/** Pet identity. Owned by Host (domains §一.1, §一.8). */
export type PetIdentityDeps = Pick<ServerDeps, 'petId' | 'petName'>;

/** What a runtime-config projection reads. Owned by Config (domains §一.5). */
export type RuntimeProjectionDeps =
  & Pick<ServerDeps, 'serverMode' | 'modelProfiles'>
  & HostExecutionConfig;

/**
 * Everything assembling one execution needs beyond the session's own identity.
 */
export type ChatSetupDeps =
  & Pick<
    ServerDeps,
    | 'modelProfiles'
    | 'capabilityCatalog'
    | 'toolkitInventory'
    | 'toolkitRuntimeManager'
    | 'defaultCapabilityName'
    | 'petDocument'
  >
  & HostExecutionConfig
  & Pick<ServerDeps, 'capabilityArtifactStore'>;

export type ServerRuntimeDepsStore = Readonly<{
  get: () => Readonly<ServerDeps>;
  updateReviewPolicy: (
    mode: BuiltinGlobalReviewPolicyMode,
    safetyLevel: ToolAuthorizationSafetyLevel,
  ) => Readonly<ServerDeps>;
}>;

export function getLocalServerToolkitInventory(
  deps: Pick<ServerDeps, 'toolkitInventory'>,
): HostToolkitInventorySnapshot {
  return deps.toolkitInventory.getSnapshot();
}

/** One Host-owned current snapshot shared by conversation and dispatch surfaces. */
export function createLocalServerRuntimeDepsStore(
  deps: ServerDeps,
): ServerRuntimeDepsStore {
  let current = Object.freeze({ ...deps });
  return Object.freeze({
    get: () => current,
    updateReviewPolicy: (globalReviewPolicyMode, autoAuthorizationSafetyLevel) => {
      current = Object.freeze({ ...current, globalReviewPolicyMode, autoAuthorizationSafetyLevel });
      return current;
    },
  });
}
