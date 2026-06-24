import type { BaseMessage, AIMessage } from '@langchain/core/messages';
import type { RunnableConfig } from '@langchain/core/runnables';
import type { StructuredTool } from '@langchain/core/tools';
import type { BaseCheckpointSaver } from '@langchain/langgraph-checkpoint';
import type { AgentCapability } from '../../types/capability';
import type { AgentActor, AgentExecution, AgentModels } from '../../types/agent';
import type { CapabilityArtifactStore } from '../../types/artifact';
import type { SubagentCompletionReason, SubagentToolEventHandler } from '../../types/subagent';
import type { AgentToolkit, ToolkitReviewCapabilities } from '../../types/toolkit';
import type { GlobalReviewPolicy } from './review/globalReviewPolicy';
import type { StructuredOutputAutoRepairConfig, StructuredOutputMethod } from '../../utils/structuredOutput';
import type { OrchestrationDecision } from './schemas';

export type MessageLane = 'general' | `capability:${string}`;
export type PinpetMessageLane = MessageLane | 'orchestrator';
export type DelegationStatus = 'pending' | 'progress' | 'completed';
export type AnnounceKind = 'completed' | 'progress';
export type { SubagentCompletionReason };

export type RunDelegation = {
  id: string;
  lane: MessageLane;
  task: string;
  status: DelegationStatus;
  resultPreview: string | null;
};

export type RunPendingDelegation = {
  id: string;
  lane: MessageLane;
  task: string;
  contextSummary: string | null;
};

export type TaskActiveDelegation = {
  id: string;
  lane: MessageLane;
  task: string;
  contextSummary: string | null;
  transcriptRunId: string;
  status: 'pending' | 'awaiting_decision';
  resultPreview: string | null;
};

export type CapabilityCandidate = {
  name: string;
  description: string;
  score: number;
  matchedTerms: string[];
};

export type RunCapabilitySearchState = {
  query: string | null;
  attempted: boolean;
  candidates: CapabilityCandidate[];
};

export type SubagentAnnounce = {
  lane: MessageLane;
  delegationId: string | null;
  task: string | null;
  text: string | null;
};

export type DecisionMode = 'finish' | 'general' | 'capability';

/**
 * How a `finish`-bucket decision should be turned into a user-facing reply.
 * - 'answer': route to the dedicated answer node, which reads the full
 *   conversation and synthesizes the reply.
 * - 'inline': a degenerate fallback or stop path already emitted a fixed reply;
 *   the run ends without the answer node.
 * - null: not a finish-bucket decision (delegation in progress).
 */
export type RunFinalReplyRoute = 'answer' | 'inline' | null;
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
  /**
   * Artifact store (a port; the host supplies the concrete adapter). Injected
   * into each capability's `CapabilityContext` so capabilities can persist
   * artifacts without the host threading the store through every capability
   * factory. Optional — surfaces without a store (e.g. tests, studio) skip writes.
   */
  capabilityArtifactStore?: CapabilityArtifactStore;
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
  reviewCapabilities?: ToolkitReviewCapabilities;
  globalReviewPolicy?: GlobalReviewPolicy;
  /**
   * 强制以"已发现候选"形态登记的 capability 名字列表。`prepare` 节点会
   * 据此 pre-seed `runCapabilitySearchState`,跳过 capability discovery/search。
   * 仅由 Studio 等明确知道需要哪个 capability 的调用方注入;通用 pet agent
   * 不传 → 0 行为变化。
   */
  forcedCapabilityNames?: string[];
};

export type OrchestrationDecisionStructuredOutputOptions = {
  name: string;
  method?: StructuredOutputMethod;
  strict?: boolean;
  autoRepair?: StructuredOutputAutoRepairConfig;
};

export type OrchestrationDecisionStructuredOutputConfig = Omit<OrchestrationDecisionStructuredOutputOptions, 'name'>;
