import type { AgentCapability, AgentToolkit, CapabilityArtifactStore } from '@pinpawo/pet-agent';
import type { LocalStudioDueRunScheduler } from './localStudioDueRunScheduler';
import type { AgentLlmConfig } from './agentConfig';
import type { LoadedUserCapability } from './capabilityLoader';
import type { LocalAgentRuntimeConfig } from './runtimeConfig';

export type LocalServerMode = 'chat' | 'studio';

export type LocalServerDeps = {
  actorId: string;
  actorName?: string;
  llmConfig: AgentLlmConfig;
  workdir: string;
  mode?: LocalServerMode;
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
