import type { BaseCheckpointSaver } from '@langchain/langgraph-checkpoint';
import type { AgentCapability } from '../../types/capability';
import type { AgentActor, AgentExecution, AgentModels } from '../../types/agent';
import type { CapabilityArtifactRef, CapabilityArtifactStore } from '../../types/artifact';
import type { SubagentCompletionReason } from '../../types/subagent';
import type {
  AgentToolkit,
  ModelInputModality,
  ToolkitReviewCapabilities,
} from '../../types/toolkit';
import type { CompiledAgentRegistry } from './registry';
import type { RunSupervisorRunner } from './runSupervisor/runner';
import type { CapabilityRegistryBackend } from './runSupervisor/registryDocuments';
import type { GlobalReviewPolicy } from './review/globalReviewPolicy';
import type { ToolkitRuntimeManager } from './toolkitRuntime';
import type { StructuredOutputAutoRepairConfig, StructuredOutputMethod } from '../../utils/structuredOutput';

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
  mode: 'initial' | 'continue';
  task: string;
  contextSummary: string | null;
};

export type CapabilityPlanTask = {
  /** Planned capability boundary that has not started yet. */
  capability: string;
  task: string;
};

/** Exact text of the HumanMessage that started the current run. */
export type UserRequest = string;

export type TaskActiveDelegation = {
  id: string;
  lane: MessageLane;
  task: string;
  contextSummary: string | null;
  transcriptRunId: string;
  /** Stable user-task identity across fresh runs that resume this delegation. */
  traceId: string;
  status: 'pending' | 'awaiting_decision';
  resultPreview: string | null;
  /** Snapshot used to restore runUserRequest when this delegation is resumed. */
  userRequest: UserRequest;
};

export type SubagentAnnounce = {
  messageId: string | null;
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

export type OrchestratorConfig = {
  models: AgentModels;
  /**
   * Capability document preloaded by the entry Supervisor as its default
   * candidate. Defaults to the well-known `general` Capability. This changes
   * candidate preference only; it does not bypass registry availability or an
   * invocation-scoped Capability allowlist.
   */
  defaultCapabilityName?: string;
  /**
   * Input modalities accepted by the active model profile. Tools declaring
   * `requiresInputModalities` bind only when this covers them; omitting it is
   * read as text-only.
   */
  modelInputModalities?: readonly ModelInputModality[];
  actor?: AgentActor;
  checkpoint?: BaseCheckpointSaver;
  /**
   * Maximum number of orchestration iterations per active delegation lifecycle in one
   * run. This is runtime guardrail only; it does not replace LLM decision logic.
   */
  maxRunIterations?: number;
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
   * Typed seam for the framework-internal Run Supervisor. Production
   * defaults to createRunSupervisorAgent(); graph tests may inject a
   * scripted runner without simulating its private file-tool transcript.
   */
  runSupervisorRunner?: RunSupervisorRunner;
  /**
   * Maximum Capability discovery model turns per Supervisor input. Defaults to 2.
   * Parallel capability_search calls in one model response count as one round.
   */
  runSupervisorMaxSearchRounds?: number;
  /**
   * Storage/search backend for the immutable Capability registry documents.
   * Defaults to filesystem. Memory is opt-in and never used as an automatic fallback.
   */
  capabilityRegistryBackend?: CapabilityRegistryBackend;
  /**
   * Host-owned optional Toolkit runtime lifecycle. The orchestrator resolves
   * per-subagent bindings through it, but the manager itself remains outside
   * model context and checkpoint state.
   */
  toolkitRuntimeManager?: ToolkitRuntimeManager;
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
   * Explicit Capability scope for this run. The Supervisor workspace contains
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

export type OrchestrationDecisionStructuredOutputConfig = Omit<
  OrchestrationDecisionStructuredOutputOptions,
  'name'
>;
