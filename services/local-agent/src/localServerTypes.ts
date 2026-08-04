import type {
  AgentCapability,
  AgentToolkit,
  BuiltinGlobalReviewPolicyMode,
  CapabilityArtifactStore,
  ToolkitRuntimeManager,
} from '@pinpawo/pet-agent';
import type { LocalStudioDueRunScheduler } from './localStudioDueRunScheduler';
import type { LoadedUserCapability } from './capabilityLoader';
import type { LocalModelProfileRegistry } from './llmConfig';
import { buildWorkspaceRuntimeConfig, type LocalAgentRuntimeConfig } from './runtimeConfig';

export type LocalServerDeps = {
  actorId: string;
  actorName?: string;
  modelProfiles: LocalModelProfileRegistry;
  globalReviewPolicyMode: BuiltinGlobalReviewPolicyMode;
  workdir: string;
  runtimeConfig?: LocalAgentRuntimeConfig;
  studioDueRunScheduler?: LocalStudioDueRunScheduler;
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
    updateCapabilities: (patch: LocalServerCapabilityStatePatch) => {
      current = Object.freeze(freezeCapabilityLists({
        ...current,
        ...patch,
      }));
      return current;
    },
  });
}
