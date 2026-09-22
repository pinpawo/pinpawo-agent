import type { ProviderTokenUsage } from '../../tokenUsage';
import type { CapabilityExecutionState } from './state';
import type { BaseMessage } from '@langchain/core/messages';
import type { LangGraphRunnableConfig } from '@langchain/langgraph';
import type { createSubagent } from '../../../subagent/createSubagent';
import type { AgentModels } from '../../../types/agent';
import type { CapabilityArtifactRef, CapabilityArtifactStore } from '../../../types/artifact';
import type { ModelInputModality, ToolkitReviewCapabilities } from '../../../types/toolkit';
import type { DelegationSpec } from '../delegation';
import type { DelegationDelivery } from '../delegation/delivery';
import type { CompiledCapability } from '../registry';
import type { GlobalReviewPolicy } from '../review/globalReviewPolicy';
import type { ToolAuthorizationRecord } from '../../../autoReview/reviewAuthorizations';
import type { ToolkitRuntimeManager } from '../toolkitRuntime';

/** Task data, not rendered briefing text or a graph routing command. */
export type CapabilityExecutionDelegation = Readonly<DelegationSpec> & {
  readonly id: string;
  readonly runId: string;
  readonly taskId: string;
};

export type CapabilityExecutionInput = {
  /** Resolved by the caller's registry, never supplied directly by the model. */
  readonly capability: CompiledCapability;
  readonly delegation: CapabilityExecutionDelegation;
  /**
   * Root conversation snapshot; selected messages must already have stable IDs.
   * Private execution history is supplied only through the dedicated state.
   */
  readonly history: readonly BaseMessage[];
  readonly state?: CapabilityExecutionState | null;
};

/** Host-supplied execution context, separate from the delegated task. */
export type CapabilityExecutionContext = {
  readonly review: {
    readonly hostCapabilities?: ToolkitReviewCapabilities;
    readonly policy?: GlobalReviewPolicy;
    /** Already filtered to the caller's current authorization generation. */
    readonly authorizations: readonly ToolAuthorizationRecord[];
  };
  /**
   * Single source of thread identity and workdir (configurable.thread_id / context.workdir).
   * Forward unchanged to preserve parent checkpoint, stream and abort handling.
   */
  readonly runnableConfig?: LangGraphRunnableConfig;
};

export type CapabilityExecutionOptions = {
  readonly models: AgentModels;
  readonly modelInputModalities?: readonly ModelInputModality[];
  readonly capabilityArtifactStore?: CapabilityArtifactStore;
  readonly toolkitRuntimeManager?: ToolkitRuntimeManager;
  readonly subagentContextWindowTokens?: number;
  readonly subagentGenerationReserveTokens?: number;
  /** Internal execution seam; production uses the existing createSubagent wrapper. */
  readonly runSubagent?: typeof createSubagent;
};

export type CapabilityExecutionResult = {
  readonly status: 'returned' | 'paused' | 'missing_deliverable';
  readonly delivery: DelegationDelivery | null;
  /** Complete private snapshot for this delegation; never appended to Root messages. */
  readonly state: CapabilityExecutionState;
  /** Provider usage from newly committed private messages in this attempt. */
  readonly tokenUsage: ProviderTokenUsage | null;
  readonly artifacts: CapabilityArtifactRef[];
  /** Execution-local snapshot; a future parallel caller must merge, not overwrite. */
  readonly toolAuthorizations: ToolAuthorizationRecord[];
};
