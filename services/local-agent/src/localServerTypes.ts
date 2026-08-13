import type {
  AgentCapability,
  AgentToolkit,
  BuiltinGlobalReviewPolicyMode,
  CapabilityArtifactStore,
  ToolkitRuntimeManager,
} from '@pinpawo/pet-agent';
import type { BaseCheckpointSaver } from '@langchain/langgraph-checkpoint';
import type { ToolAuthorizationSafetyLevel } from '@pinpawo/agent-contracts';
import type { LoadedUserCapability } from './capabilityLoader';
import type { LocalModelProfileRegistry } from './llmConfig';
import { buildWorkspaceRuntimeConfig, type LocalAgentRuntimeConfig } from './runtimeConfig';
import type { ServerMode } from './serverMode';

/**
 * #561: startup-determined Studio facts. Present only in studio mode, where
 * they are validated during startup preflight rather than per request.
 */
export type LocalServerStudioModeInfo = {
  studioId: string;
  entryPetId: string;
  petIds: readonly string[];
};

export type LocalServerDeps = {
  /** #561 primary server mode, decided at startup. */
  serverMode: ServerMode;
  /** Present only in studio mode. */
  studioMode?: LocalServerStudioModeInfo;
  actorId: string;
  actorName?: string;
  modelProfiles: LocalModelProfileRegistry;
  globalReviewPolicyMode: BuiltinGlobalReviewPolicyMode;
  autoAuthorizationSafetyLevel: ToolAuthorizationSafetyLevel;
  workdir: string;
  runtimeConfig?: LocalAgentRuntimeConfig;
  /**
   * Host 持有的 chat checkpointer。Studio 的 pet 复用同一实例:threadId
   * 已含 studio/run/task/pet/invocation 层级,与 chat 线程天然隔离,
   * 而 FileSaver 自带 per-checkpoint 写锁,并发写不会互相覆盖。
   *
   * 缺少它时 pet 的 graph 跑在无 checkpoint 状态 —— 执行进度只存在于内存,
   * 中断后无法 resume。见 #613。
   */
  chatCheckpointer?: BaseCheckpointSaver;
  localToolkitDefinitions?: AgentToolkit[];
  localToolkits?: AgentToolkit[];
  pluginToolkitDefinitions?: AgentToolkit[];
  pluginToolkits?: AgentToolkit[];
  toolkitRuntimeManager?: ToolkitRuntimeManager;
  localCapabilities?: AgentCapability[];
  userCapabilities?: LoadedUserCapability[];
  capabilityArtifactStore?: CapabilityArtifactStore;
  rescanUserCapabilities?: () => Promise<LoadedUserCapability[]>;
};

export type NormalizedLocalServerDeps = Readonly<Omit<LocalServerDeps, 'workdir' | 'runtimeConfig'> & {
  workdir: string;
  runtimeConfig: LocalAgentRuntimeConfig;
}>;

export type LocalServerCapabilityStatePatch = Partial<Pick<LocalServerDeps,
  | 'localToolkitDefinitions'
  | 'localToolkits'
  | 'pluginToolkitDefinitions'
  | 'pluginToolkits'
  | 'localCapabilities'
  | 'userCapabilities'
>>;

export type LocalServerRuntimeDepsStore = Readonly<{
  get: () => NormalizedLocalServerDeps;
  updateGlobalReviewPolicyMode: (
    mode: BuiltinGlobalReviewPolicyMode,
  ) => NormalizedLocalServerDeps;
  updateAutoAuthorizationSafetyLevel: (
    safetyLevel: ToolAuthorizationSafetyLevel,
  ) => NormalizedLocalServerDeps;
  updateCapabilities: (patch: LocalServerCapabilityStatePatch) => NormalizedLocalServerDeps;
}>;

function freezeList<T>(value: T[] | undefined): T[] | undefined {
  return value ? Object.freeze([...value]) as T[] : undefined;
}

function freezeCapabilityLists<T extends LocalServerDeps>(deps: T): T {
  return {
    ...deps,
    localToolkitDefinitions: freezeList(deps.localToolkitDefinitions),
    localToolkits: freezeList(deps.localToolkits),
    pluginToolkitDefinitions: freezeList(deps.pluginToolkitDefinitions),
    pluginToolkits: freezeList(deps.pluginToolkits),
    localCapabilities: freezeList(deps.localCapabilities),
    userCapabilities: freezeList(deps.userCapabilities),
  };
}

export function getLocalServerRuntimeConfig(deps: LocalServerDeps): LocalAgentRuntimeConfig {
  return deps.runtimeConfig ?? buildWorkspaceRuntimeConfig({ workdir: deps.workdir });
}

export function getLocalServerWorkdir(deps: LocalServerDeps): string {
  return deps.runtimeConfig?.workdir ?? deps.workdir;
}

export function normalizeLocalServerDeps(deps: LocalServerDeps): NormalizedLocalServerDeps {
  const runtimeConfig = getLocalServerRuntimeConfig(deps);
  return Object.freeze(freezeCapabilityLists({
    ...deps,
    workdir: runtimeConfig.workdir,
    runtimeConfig,
  }));
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
    updateCapabilities: (patch: LocalServerCapabilityStatePatch) => {
      current = Object.freeze(freezeCapabilityLists({
        ...current,
        ...patch,
      }));
      return current;
    },
  });
}
