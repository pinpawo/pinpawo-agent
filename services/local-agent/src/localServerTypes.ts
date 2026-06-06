import type { StructuredTool } from '@langchain/core/tools';
import type { AgentCapability, AgentToolkit } from '@pinpawo/pet-agent';
import type { AgentLlmConfig } from './agentConfig';
import type { LoadedUserCapability } from './capabilityLoader';

export type AgentStats = {
  startedAt: string;
  totalRuns: number;
  successfulRuns: number;
  failedRuns: number;
  lastRunAt: string | null;
  lastRunOk: boolean | null;
};

export type LocalServerDeps = {
  actorId: string;
  actorName?: string;
  llmConfig: AgentLlmConfig;
  workdir: string;
  localTools: StructuredTool[];
  localToolkitDefinitions?: AgentToolkit[];
  localToolkits?: AgentToolkit[];
  pluginTools: StructuredTool[];
  pluginToolkits?: AgentToolkit[];
  localCapabilityDefinitions?: AgentCapability[];
  localCapabilities?: AgentCapability[];
  userCapabilityDefinitions?: LoadedUserCapability[];
  userCapabilities?: LoadedUserCapability[];
  rescanUserCapabilities?: () => Promise<{
    userCapabilityDefinitions: LoadedUserCapability[];
    userCapabilities: LoadedUserCapability[];
  }>;
  getStats: () => AgentStats;
};
