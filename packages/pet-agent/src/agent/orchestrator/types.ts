import type { BaseMessage, AIMessage } from '@langchain/core/messages';
import type { RunnableConfig } from '@langchain/core/runnables';
import type { StructuredTool } from '@langchain/core/tools';
import type { BaseCheckpointSaver } from '@langchain/langgraph-checkpoint';
import type { AgentCapability } from '../../types/capability';
import type { AgentActor, AgentExecution, AgentModels } from '../../types/agent';
import type { CapabilityArtifactRef, CapabilityArtifactStore } from '../../types/artifact';
import type { SubagentCompletionReason } from '../../types/subagent';
import type { AgentToolkit, ToolkitReviewCapabilities } from '../../types/toolkit';
import type { CompiledAgentRegistry } from './registry';
import type { GlobalReviewPolicy } from './review/globalReviewPolicy';
import type { StructuredOutputAutoRepairConfig, StructuredOutputMethod } from '../../utils/structuredOutput';
import type { DelegationOutcomeDecision } from './schemas';

export type MessageLane = 'general' | `capability:${string}`;
export type PinpetMessageLane = MessageLane | 'orchestrator';
export type DelegationStatus = 'pending' | 'progress' | 'completed';
export type { SubagentCompletionReason };

export type RunDelegationSummary = {
  id: string;
  lane: MessageLane;
  task: string;
  status: DelegationStatus;
  resultPreview: string | null;
};

export type RunNextDelegation = {
  id: string;
  lane: MessageLane;
  task: string;
  contextSummary: string | null;
};

export type RunPendingTask = {
  task: string;
  contextSummary: string | null;
};

export type CapabilityPlanTask = {
  /** Planned capability boundary that has not started yet. */
  objective: string;
  capabilityIntent: string;
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

export type SubagentAnnounce = {
  lane: MessageLane;
  delegationId: string | null;
  task: string | null;
  text: string | null;
  artifactRefs?: Pick<
    CapabilityArtifactRef,
    'id' | 'kind' | 'mimeType' | 'uri' | 'title' | 'preview' | 'capabilityId' | 'delegationId' | 'runId'
  >[];
};

export type DecisionMode = 'answer' | 'general' | 'capability';

export type ToolBindableChatModel = AgentModels['act'] & {
  bindTools?: (tools: StructuredTool[], options?: Record<string, unknown>) => {
    invoke: (messages: BaseMessage[], options?: RunnableConfig) => Promise<AIMessage>;
  };
};

export type StructuredOrchestrationDecisionModel = {
  invoke: (messages: BaseMessage[], options?: RunnableConfig) => Promise<DelegationOutcomeDecision>;
};

export type OrchestratorConfig = {
  models: AgentModels;
  actor?: AgentActor;
  checkpoint?: BaseCheckpointSaver;
  /**
   * Maximum number of orchestration iterations per active delegation lifecycle in one
   * run. This is runtime guardrail only; it does not replace LLM decision logic.
   */
  maxRunIterations?: number;
  decisionStructuredOutput?: OrchestrationDecisionStructuredOutputConfig;
  contextWindowTokens?: number;
  /**
   * Context window for subagent model calls. Defaults to `contextWindowTokens`
   * when subagents use the same model/window as the main orchestrator.
   */
  subagentContextWindowTokens?: number;
  /**
   * Artifact store (a port; the host supplies the concrete adapter). Injected
   * into the selected capability's narrow `CapabilityFinalizeContext`.
   * Optional — surfaces without a store (e.g. tests, studio) skip writes.
   */
  capabilityArtifactStore?: CapabilityArtifactStore;
};

export type OrchestratorInvokeOptions = {
  actor?: AgentActor;
  /** Host-compiled executable registry. Required by routing and executor nodes. */
  registry?: CompiledAgentRegistry;
  execution?: AgentExecution;
  workdir?: string;
  runtimeEnvironment?: string;
  reviewCapabilities?: ToolkitReviewCapabilities;
  globalReviewPolicy?: GlobalReviewPolicy;
  maxRunIterations?: number;
  /**
   * 强制加入本次 capabilityDecision 局部候选集的 capability 名字列表。
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
