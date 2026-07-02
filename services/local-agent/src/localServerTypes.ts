import type { AgentCapability, AgentToolkit, CapabilityArtifactStore } from '@pinpawo/pet-agent';
import type { LocalStudioDueRunScheduler } from './localStudioDueRunScheduler';
import type { AgentLlmConfig } from './agentConfig';
import type { LoadedUserCapability } from './capabilityLoader';
import type { LocalAgentRuntimeConfig } from './runtimeConfig';
import type { StoredConfig } from './storage';

export type LocalServerDeps = {
  actorId: string;
  actorName?: string;
  llmConfig: AgentLlmConfig;
  workdir: string;
  runtimeConfig?: LocalAgentRuntimeConfig;
  workspaceRegistryPath?: string;
  saveStoredConfig?: (config: StoredConfig) => void;
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
