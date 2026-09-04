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
import { buildWorkspaceRuntimeConfig, type LocalAgentRuntimeConfig } from './runtimeConfig';
import type { ServerMode } from './serverMode';
import {
  type HostToolkitInventorySnapshot,
  HostToolkitInventoryStore,
} from './toolkits/toolkitInventory';

export type CapabilityCatalogReader = Pick<
  HostCapabilityCatalog,
  'getSnapshot'
>;

export type LocalServerDeps = {
  /** Local-agent interaction mode; resident Pet adapters reuse the Chat semantics. */
  serverMode: ServerMode;
  actorId: string;
  actorName?: string;
  modelProfiles: LocalModelProfileRegistry;
  globalReviewPolicyMode: BuiltinGlobalReviewPolicyMode;
  autoAuthorizationSafetyLevel: ToolAuthorizationSafetyLevel;
  workdir: string;
  runtimeConfig?: LocalAgentRuntimeConfig;
  /**
   * Composition Host 持有的 conversation checkpointer。Chat Host 与 Studio Host
   * 使用独立 root，但都通过同一 local-agent session stack 注入。FileSaver 仍提供
   * store-wide filesystem writer lock，保护同一 root 被意外多进程打开时的
   * read-modify-write 与 GC。
   *
   * 缺少它时 pet 的 graph 跑在无 checkpoint 状态 —— 执行进度只存在于内存,
   * 中断后无法 resume。见 #613。
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

export type NormalizedLocalServerDeps = Readonly<Omit<
  LocalServerDeps,
  'workdir' | 'runtimeConfig'
> & {
  workdir: string;
  runtimeConfig: LocalAgentRuntimeConfig;
}>;

export type LocalServerRuntimeDepsStore = Readonly<{
  get: () => NormalizedLocalServerDeps;
  updateGlobalReviewPolicyMode: (
    mode: BuiltinGlobalReviewPolicyMode,
  ) => NormalizedLocalServerDeps;
  updateAutoAuthorizationSafetyLevel: (
    safetyLevel: ToolAuthorizationSafetyLevel,
  ) => NormalizedLocalServerDeps;
}>;

export function getLocalServerRuntimeConfig(deps: LocalServerDeps): LocalAgentRuntimeConfig {
  return deps.runtimeConfig ?? buildWorkspaceRuntimeConfig({ workdir: deps.workdir });
}

export function getLocalServerWorkdir(deps: LocalServerDeps): string {
  return deps.runtimeConfig?.workdir ?? deps.workdir;
}

export function getLocalServerToolkitInventory(
  deps: Pick<LocalServerDeps, 'toolkitInventory'>,
): HostToolkitInventorySnapshot {
  return deps.toolkitInventory.getSnapshot();
}

export function normalizeLocalServerDeps(deps: LocalServerDeps): NormalizedLocalServerDeps {
  const runtimeConfig = getLocalServerRuntimeConfig(deps);
  return Object.freeze({
    ...deps,
    workdir: runtimeConfig.workdir,
    runtimeConfig,
  });
}

export function createLocalServerRuntimeDepsStore(
  deps: LocalServerDeps,
): LocalServerRuntimeDepsStore {
  let current = normalizeLocalServerDeps(deps);
  return Object.freeze({
    get: () => current,
    updateGlobalReviewPolicyMode: (globalReviewPolicyMode) => {
      current = Object.freeze({
        ...current,
        globalReviewPolicyMode,
      });
      return current;
    },
    updateAutoAuthorizationSafetyLevel: (autoAuthorizationSafetyLevel) => {
      current = Object.freeze({
        ...current,
        autoAuthorizationSafetyLevel,
      });
      return current;
    },
  });
}
