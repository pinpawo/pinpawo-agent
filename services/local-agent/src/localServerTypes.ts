import type {
  BuiltinGlobalReviewPolicyMode,
  CapabilityArtifactStore,
  PetDocument,
  ToolkitRuntimeManager,
} from '@pinpawo/pet-agent';
import type { BaseCheckpointSaver } from '@langchain/langgraph-checkpoint';
import type { ToolAuthorizationSafetyLevel } from '@pinpawo/agent-contracts';
import type { HostCapabilityCatalog } from './hostCapabilityCatalog';
import type { LocalModelProfileRegistry } from './llmConfig';
import type { HostExecutionConfig } from './hostExecutionConfig';
import type { ServerMode } from './serverMode';
import {
  type HostToolkitInventorySnapshot,
  HostToolkitInventoryStore,
} from './toolkits/toolkitInventory';

export type CapabilityCatalogReader = Pick<
  HostCapabilityCatalog,
  'getSnapshot'
>;

export type LocalServerDeps = HostExecutionConfig & {
  /** Local-agent interaction mode; resident Pet adapters reuse the Chat semantics. */
  serverMode: ServerMode;
  actorId: string;
  actorName?: string;
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
  capabilityArtifactStore?: CapabilityArtifactStore;
};

export type LocalServerRuntimeDepsStore = Readonly<{
  get: () => Readonly<LocalServerDeps>;
  updateReviewPolicy: (
    mode: BuiltinGlobalReviewPolicyMode,
    safetyLevel: ToolAuthorizationSafetyLevel,
  ) => Readonly<LocalServerDeps>;
}>;

export function getLocalServerToolkitInventory(
  deps: Pick<LocalServerDeps, 'toolkitInventory'>,
): HostToolkitInventorySnapshot {
  return deps.toolkitInventory.getSnapshot();
}

/** One Host-owned current snapshot shared by conversation and dispatch surfaces. */
export function createLocalServerRuntimeDepsStore(
  deps: LocalServerDeps,
): LocalServerRuntimeDepsStore {
  let current = Object.freeze({ ...deps });
  return Object.freeze({
    get: () => current,
    updateReviewPolicy: (globalReviewPolicyMode, autoAuthorizationSafetyLevel) => {
      current = Object.freeze({ ...current, globalReviewPolicyMode, autoAuthorizationSafetyLevel });
      return current;
    },
  });
}
