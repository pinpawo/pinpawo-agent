import type { BaseMessage, AIMessage } from '@langchain/core/messages';
import type { RunnableConfig } from '@langchain/core/runnables';
import type { StructuredTool } from '@langchain/core/tools';
import type { BaseCheckpointSaver } from '@langchain/langgraph-checkpoint';
import type { AgentCapability } from '../../types/capability';
import type { AgentActor, AgentExecution, AgentModels } from '../../types/agent';
import type { SubagentCompletionReason, SubagentToolEventHandler } from '../../types/subagent';
import type { AgentToolkit } from '../../types/toolkit';
import type { OrchestrationDecision } from './schemas';

export type MessageLane = 'general' | `capability:${string}`;
export type PinpetMessageLane = MessageLane | 'orchestrator';
export type DelegationStatus = 'pending' | 'progress' | 'completed';
export type AnnounceKind = 'completed' | 'progress';
export type { SubagentCompletionReason };

export type TurnDelegation = {
  id: string;
  lane: MessageLane;
  task: string;
  status: DelegationStatus;
  resultPreview: string | null;
};

export type PendingDelegation = {
  id: string;
  lane: MessageLane;
  task: string;
  contextSummary: string | null;
};

export type CapabilityCandidate = {
  name: string;
  description: string;
  score: number;
  matchedTerms: string[];
};

export type CapabilitySearchState = {
  query: string | null;
  attempted: boolean;
  candidates: CapabilityCandidate[];
};

export type SubagentAnnounce = {
  lane: MessageLane;
  delegationId: string | null;
  task: string | null;
  announce: AnnounceKind;
  text: string | null;
};

export type DecisionMode = 'finish' | 'general' | 'capability';
export type CapabilityDecisionState = 'unavailable' | 'search_available' | 'candidates_available' | 'search_exhausted';

export type ToolBindableChatModel = AgentModels['act'] & {
  bindTools?: (tools: StructuredTool[], options?: Record<string, unknown>) => {
    invoke: (messages: BaseMessage[], options?: RunnableConfig) => Promise<AIMessage>;
  };
};

export type StructuredOrchestrationDecisionModel = {
  invoke: (messages: BaseMessage[], options?: RunnableConfig) => Promise<OrchestrationDecision>;
};

export type OrchestratorConfig = {
  models: AgentModels;
  actor?: AgentActor;
  checkpoint?: BaseCheckpointSaver;
  decisionStructuredOutput?: OrchestrationDecisionStructuredOutputConfig;
  contextWindowTokens?: number;
};

export type OrchestratorInvokeOptions = {
  actor?: AgentActor;
  capabilities?: AgentCapability[];
  toolkits?: AgentToolkit[];
  maxIterations?: number;
  execution?: AgentExecution;
  workdir?: string;
  runtimeEnvironment?: string;
  onToolEvent?: SubagentToolEventHandler;
  /**
   * 强制以"已发现候选"形态登记的 capability 名字列表。`prepare` 节点会
   * 据此 pre-seed `capabilitySearchState`,跳过 capability discovery/search。
   * 仅由 Studio 等明确知道需要哪个 capability 的调用方注入;通用 pet agent
   * 不传 → 0 行为变化。
   */
  forcedCapabilityNames?: string[];
};

export type OrchestrationDecisionStructuredOutputOptions = {
  name: string;
  method?: 'functionCalling' | 'jsonMode' | 'jsonSchema';
  strict?: boolean;
};

export type OrchestrationDecisionStructuredOutputConfig = Omit<OrchestrationDecisionStructuredOutputOptions, 'name'>;
