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
import type { CapabilityPlannerRunner } from './capabilityPlannerRunner';
import type { GlobalReviewPolicy } from './review/globalReviewPolicy';
import type { StructuredOutputAutoRepairConfig, StructuredOutputMethod } from '../../utils/structuredOutput';
import type { DelegationOutcomeDecision } from './schemas';

export type MessageLane = `capability:${string}`;
export type PinpetMessageLane = MessageLane | 'orchestrator';
export type DelegationStatus = 'pending' | 'progress' | 'completed';
export type { SubagentCompletionReason };

export type ActiveDelegationTransition = 'supersede_active' | 'resume_active';

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
  capability: string;
  task: string;
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

export type DecisionMode = 'answer' | 'capability';

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
  /** Output + reasoning capacity reserved before deriving input maintenance thresholds. */
  generationReserveTokens?: number;
  /**
   * Context window for subagent model calls. Defaults to `contextWindowTokens`
   * when subagents use the same model/window as the main orchestrator.
   */
  subagentContextWindowTokens?: number;
  /** Defaults to `generationReserveTokens` when the same model serves subagents. */
  subagentGenerationReserveTokens?: number;
  /**
   * Artifact store (a port; the host supplies the concrete adapter). Injected
   * into the selected capability's narrow `CapabilityFinalizeContext`.
   * Optional — surfaces without a store (e.g. tests, studio) skip writes.
   */
  capabilityArtifactStore?: CapabilityArtifactStore;
  /**
   * Typed seam for the framework-internal Capability Planner. Production
   * defaults to createCapabilityPlannerAgent(); graph tests may inject a
   * scripted runner without simulating its private file-tool transcript.
   */
  capabilityPlannerRunner?: CapabilityPlannerRunner;
  /**
   * Absolute cache root for immutable Capability Document Workspaces.
   * Defaults to a process-independent directory under the OS temp root.
   */
  capabilityPlannerWorkspaceRoot?: string;
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
   * Explicit Capability scope for this run. The Planner workspace contains
   * only compiled capabilities in this allowlist. Omit to expose the complete
   * compiled registry.
   */
  allowedCapabilityNames?: string[];
};

export type OrchestrationDecisionStructuredOutputOptions = {
  name: string;
  method?: StructuredOutputMethod;
  strict?: boolean;
  autoRepair?: StructuredOutputAutoRepairConfig;
};

export type OrchestrationDecisionStructuredOutputConfig = Omit<OrchestrationDecisionStructuredOutputOptions, 'name'>;
