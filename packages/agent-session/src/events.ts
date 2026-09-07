import type {
  TokenUsageSnapshot,
} from '@pinpawo/agent-contracts';
import type { AgentPlan } from './domain';
import type { HumanReviewPendingInterruptProjection } from './review';

export type AgentRuntimeEvent =
  | AgentRunStartedEvent
  | AgentRunInterruptedEvent
  | AgentAssistantMessageEvent
  | AgentSubagentMessageCompletedEvent
  | AgentOperationEvent
  | AgentPlanUpdatedEvent
  | AgentHumanReviewRequestedEvent
  | AgentSystemNoticeEvent
  | AgentErrorEvent;

/**
 * Opens a run for every observer of the session, including observers that did
 * not originate the input. `initiator` describes the transport-side source;
 * it deliberately does not name any composing Host such as Studio.
 */
export type AgentRunStartedEvent = {
  type: 'run.started';
  requestId: string;
  initiator: 'client' | 'host';
  input?: {
    role: 'user';
    text: string;
  };
};

/** Terminates a run that did not reach a message/review/error boundary. */
export type AgentRunInterruptedEvent = {
  type: 'run.interrupted';
  requestId: string;
  message?: string;
};

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
  pendingInterrupt: HumanReviewPendingInterruptProjection;
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
  // The invocation terminates; checkpoint state remains authoritative for any
  // pending interrupt and is reconciled separately.
  | 'agent_unavailable';

export type AgentErrorEvent = {
  type: 'error';
  requestId: string;
  message: string;
  code?: AgentErrorCode;
};
