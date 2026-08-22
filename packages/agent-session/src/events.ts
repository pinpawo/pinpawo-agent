import type {
  TokenUsageSnapshot,
} from '@pinpawo/agent-contracts';
import type { AgentPlan } from './domain';
import type { PendingInterruptProjection } from './review';

export type AgentRuntimeEvent =
  | AgentAssistantMessageEvent
  | AgentSubagentMessageCompletedEvent
  | AgentOperationEvent
  | AgentPlanUpdatedEvent
  | AgentHumanReviewRequestedEvent
  | AgentStudioProgressEvent
  | AgentSystemNoticeEvent
  | AgentErrorEvent;

export type AgentAssistantMessageEvent =
  | AgentMessageDeltaEvent
  | AgentMessageCompletedEvent;

export type AgentMessageDeltaEvent = {
  type: 'message.delta';
  requestId: string;
  /**
   * The upstream model lifecycle id this delta belongs to. Carrying it makes
   * assistant identity explicit, so the projection keys messages the same way
   * operations and subagent messages are keyed instead of inferring ownership
   * from timeline position and streaming status.
   */
  messageId: string;
  role: 'assistant';
  text: string;
};

export type AgentSubagentMessageCompletedEvent = {
  type: 'subagent.message.completed';
  requestId: string;
  /** The upstream child-model lifecycle id for this completed message block. */
  messageId: string;
  /** Namespace disambiguates model lifecycle ids reused by child scopes. */
  namespace: string[];
  text: string;
};

export type AgentMessageCompletedEvent = {
  type: 'message.completed';
  requestId: string;
  /** Identifies the streamed message this completion finalizes. */
  messageId: string;
  role: 'assistant';
  text: string;
  usage?: TokenUsageSnapshot;
};

export type AgentOperationPhase =
  | 'started'
  | 'updated'
  | 'completed'
  | 'failed'
  | 'interrupted';

export type AgentOperationRaw = {
  input?: unknown;
  output?: unknown;
  error?: unknown;
};

export type AgentOperationEvent = {
  type: 'operation';
  requestId: string;
  phase: AgentOperationPhase;
  operation: {
    id?: string;
    kind: string;
    title?: string;
    target?: string;
    summary?: string;
    details?: Record<string, unknown>;
    source?: {
      provider: 'toolkit' | 'runtime';
      name: string;
      toolName?: string;
      callId?: string;
    };
  };
  /**
   * Raw tool-call input/output/error. Transports currently preserve this
   * transient payload; consumers should prefer operation.summary/details for
   * stable display behavior.
   */
  raw?: AgentOperationRaw;
};

/** Replaces the current delegation plan; `null` clears it. */
export type AgentPlanUpdatedEvent = {
  type: 'plan.updated';
  requestId: string;
  plan: AgentPlan | null;
};

export type AgentHumanReviewRequestedEvent = {
  type: 'human_review.requested';
  requestId: string;
  pendingInterrupt: PendingInterruptProjection;
};

export type AgentStudioProgressEvent = {
  type: 'studio.progress';
  requestId: string;
  event: Record<string, unknown>;
};

export type AgentSystemNoticeEvent = {
  type: 'system.notice';
  requestId: string;
  message: string;
};

export type AgentErrorCode =
  | 'review_closed'
  | 'review_stale'
  | 'review_wrong_session'
  // The agent could not run at all (model quota exhausted, auth rejected).
  // The run is terminated and any pending interrupt is closed with it.
  | 'agent_unavailable';

export type AgentErrorEvent = {
  type: 'error';
  requestId: string;
  message: string;
  code?: AgentErrorCode;
};
