import type { AgentCapability, AgentToolkit } from '@pinpawo/pet-agent';
import type { AgentLlmConfig } from './agentConfig';
import type { LoadedUserCapability } from './capabilityLoader';
import type { AgentContext } from './contextLoader';

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
  connectionMode?: 'api-connected' | 'local-only';
  llmConfig: AgentLlmConfig;
  workdir: string;
  localToolkitDefinitions?: AgentToolkit[];
  localToolkits?: AgentToolkit[];
  pluginToolkits?: AgentToolkit[];
  localCapabilityDefinitions?: AgentCapability[];
  localCapabilities?: AgentCapability[];
  userCapabilityDefinitions?: LoadedUserCapability[];
  userCapabilities?: LoadedUserCapability[];
  loadContext?: (actorId: string) => Promise<AgentContext>;
  rescanUserCapabilities?: () => Promise<{
    userCapabilityDefinitions: LoadedUserCapability[];
    userCapabilities: LoadedUserCapability[];
  }>;
  getStats: () => AgentStats;
};
