import type { BaseCheckpointSaver } from '@langchain/langgraph-checkpoint';
import type { AgentCapability } from '../../types/capability';
import type { AgentModels } from '../../types/agent';
import type { CapabilityArtifactRef, CapabilityArtifactStore } from '../../types/artifact';
import type {
  AgentToolkit,
  ModelInputModality,
  ToolkitReviewCapabilities,
} from '../../types/toolkit';
import type { CompiledAgentRegistry } from './registry';
import type { RunSupervisorRunner } from './runSupervisor/runner';
import type { GlobalReviewPolicy } from './review/globalReviewPolicy';
import type { ToolkitRuntimeManager } from './toolkitRuntime';
import type { StructuredOutputAutoRepairConfig, StructuredOutputMethod } from '../../utils/structuredOutput';
import type { CapabilityMessageLane } from '../messages';

export type { CapabilityMessageLane };
/** Current user goal, including an explicitly requested Supervisor adjustment. */
export type UserRequest = string;

export type DecisionMode = 'answer' | 'capability';

export type OrchestratorConfig = {
  models: AgentModels;
  /**
   * Capability identified in the Supervisor routing manifest as its default
   * candidate. Defaults to the well-known `general` Capability. This changes
   * candidate preference only; it does not disclose the Capability document,
   * bypass registry availability, or bypass an invocation-scoped allowlist.
   */
  defaultCapabilityName?: string;
  /**
   * Input modalities accepted by the active model profile. Tools declaring
   * `requiresInputModalities` bind only when this covers them; omitting it is
   * read as text-only.
   */
  modelInputModalities?: readonly ModelInputModality[];
  checkpoint?: BaseCheckpointSaver;
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
   * scripted runner with an explicit delegation-call fixture.
   */
  runSupervisorRunner?: RunSupervisorRunner;
  /**
   * Host-owned optional Toolkit runtime lifecycle. The orchestrator resolves
   * per-subagent bindings through it, but the manager itself remains outside
   * model context and checkpoint state.
   */
  toolkitRuntimeManager?: ToolkitRuntimeManager;
};

export type OrchestratorInvokeOptions = {
  /** Host-compiled executable registry. Required by routing and executor nodes. */
  registry?: CompiledAgentRegistry;
  reviewCapabilities?: ToolkitReviewCapabilities;
  globalReviewPolicy?: GlobalReviewPolicy;
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
