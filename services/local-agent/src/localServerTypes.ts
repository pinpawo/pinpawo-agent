import type { AgentCapability, AgentToolkit, CapabilityArtifactStore } from '@pinpawo/pet-agent';
import type { AgentLlmConfig } from './agentConfig';
import type { LoadedUserCapability } from './capabilityLoader';

export type LocalServerDeps = {
  actorId: string;
  actorName?: string;
  llmConfig: AgentLlmConfig;
  workdir: string;
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
