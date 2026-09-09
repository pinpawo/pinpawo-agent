import type { BaseMessage } from '@langchain/core/messages';
import type { LangGraphRunnableConfig } from '@langchain/langgraph';
import type { createSubagent } from '../../../subagent/createSubagent';
import type { AgentModels } from '../../../types/agent';
import type { CapabilityArtifactRef, CapabilityArtifactStore } from '../../../types/artifact';
import type { ModelInputModality, ToolkitReviewCapabilities } from '../../../types/toolkit';
import type { DelegationMessageScope } from '../../messages';
import type { DelegationAnnounceData, DelegationSpec } from '../delegation';
import type { CompiledCapability } from '../registry';
import type { GlobalReviewPolicy } from '../review/globalReviewPolicy';
import type { ToolAuthorizationRecord } from '../review/reviewAuthorizations';
import type { ToolkitRuntimeManager } from '../toolkitRuntime';

/** Task data, not rendered briefing text or a graph routing command. */
export type CapabilityExecutionDelegation = Readonly<DelegationSpec> & {
  readonly id: string;
  readonly runId: string;
  readonly traceId: string;
};

export type CapabilityExecutionInput = {
  /** Resolved by the caller's registry, never supplied directly by the model. */
  readonly capability: CompiledCapability;
  readonly delegation: CapabilityExecutionDelegation;
  /**
   * Canonical history snapshot; selected messages must already have stable IDs.
   * The executor selects only main + this delegation and never assigns input IDs.
   */
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
  readonly toolkitRuntimeManager?: ToolkitRuntimeManager;
  readonly subagentContextWindowTokens?: number;
  readonly subagentGenerationReserveTokens?: number;
  /** Internal execution seam; production uses the existing createSubagent wrapper. */
  readonly runSubagent?: typeof createSubagent;
};

export type CapabilityExecutionResult = {
  readonly status: 'returned' | 'paused' | 'missing_deliverable';
  readonly scope: DelegationMessageScope & { readonly traceId: string };
  /** Unapplied per-execution message patch, not a replacement conversation. */
  readonly handoff: {
    readonly messages: BaseMessage[];
    readonly announce: DelegationAnnounceData | null;
  };
  readonly artifacts: CapabilityArtifactRef[];
  /** Execution-local snapshot; a future parallel caller must merge, not overwrite. */
  readonly toolAuthorizations: ToolAuthorizationRecord[];
};
