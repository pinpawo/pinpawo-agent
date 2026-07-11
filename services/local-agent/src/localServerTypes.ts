import type { AgentCapability, AgentToolkit, CapabilityArtifactStore } from '@pinpawo/pet-agent';
import type { LocalStudioDueRunScheduler } from './localStudioDueRunScheduler';
import type { AgentLlmConfig } from './agentConfig';
import type { LoadedUserCapability } from './capabilityLoader';
import { buildWorkspaceRuntimeConfig, type LocalAgentRuntimeConfig } from './runtimeConfig';

export type LocalServerDeps = {
  actorId: string;
  actorName?: string;
  llmConfig: AgentLlmConfig;
  workdir: string;
  runtimeConfig?: LocalAgentRuntimeConfig;
  studioDueRunScheduler?: LocalStudioDueRunScheduler;
  localToolkitDefinitions?: AgentToolkit[];
  localToolkits?: AgentToolkit[];
  pluginToolkits?: AgentToolkit[];
  localCapabilityDefinitions?: AgentCapability[];
  localCapabilities?: AgentCapability[];
  userCapabilityDefinitions?: LoadedUserCapability[];
  userCapabilities?: LoadedUserCapability[];
  capabilityArtifactStore?: CapabilityArtifactStore;
  rescanUserCapabilities?: () => Promise<{
    userCapabilityDefinitions: LoadedUserCapability[];
    userCapabilities: LoadedUserCapability[];
  }>;
};

export type NormalizedLocalServerDeps = Omit<LocalServerDeps, 'workdir' | 'runtimeConfig'> & {
  workdir: string;
  runtimeConfig: LocalAgentRuntimeConfig;
};

export function getLocalServerRuntimeConfig(deps: LocalServerDeps): LocalAgentRuntimeConfig {
  return deps.runtimeConfig ?? buildWorkspaceRuntimeConfig({ workdir: deps.workdir });
}

export function getLocalServerWorkdir(deps: LocalServerDeps): string {
  return deps.runtimeConfig?.workdir ?? deps.workdir;
}

export function normalizeLocalServerDeps(deps: LocalServerDeps): NormalizedLocalServerDeps {
  const runtimeConfig = getLocalServerRuntimeConfig(deps);
  return {
    ...deps,
    workdir: runtimeConfig.workdir,
    runtimeConfig,
  };
}
