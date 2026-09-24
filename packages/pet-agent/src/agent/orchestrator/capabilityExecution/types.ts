import type { ProviderTokenUsage } from '../../tokenUsage';
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
  /** Main conversation containing prior tool results; no child transcript replay. */
  readonly history: readonly BaseMessage[];
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
  readonly subagentContextWindowTokens?: number;
  readonly subagentGenerationReserveTokens?: number;
  /** Internal execution seam; production uses the existing createSubagent wrapper. */
  readonly runSubagent?: typeof createSubagent;
};

export type CapabilityExecutionResult = {
  readonly status: 'returned' | 'paused' | 'missing_deliverable';
  readonly delivery: DelegationDelivery | null;
  /** Provider usage reported by this invocation. */
  readonly tokenUsage: ProviderTokenUsage | null;
  readonly artifacts: CapabilityArtifactRef[];
  /** Execution-local snapshot; a future parallel caller must merge, not overwrite. */
  readonly toolAuthorizations: ToolAuthorizationRecord[];
};
