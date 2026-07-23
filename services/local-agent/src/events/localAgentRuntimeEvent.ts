import type { ReviewSpec, TokenUsageSnapshot } from '@pinpawo/pet-agent';

export type LocalAgentRuntimeEvent =
  | LocalAgentAssistantMessageEvent
  | LocalAgentSubagentMessageCompletedEvent
  | LocalAgentOperationEvent
  | LocalAgentHumanReviewRequestedEvent
  | LocalAgentStudioProgressEvent
  | LocalAgentSystemNoticeEvent
  | LocalAgentErrorEvent;

export type LocalAgentAssistantMessageEvent =
  | LocalAgentMessageDeltaEvent
  | LocalAgentMessageCompletedEvent;

export type LocalAgentMessageDeltaEvent = {
  type: 'message.delta';
  requestId: string;
  role: 'assistant';
  text: string;
};

export type LocalAgentSubagentMessageCompletedEvent = {
  type: 'subagent.message.completed';
  requestId: string;
  /** The upstream child-model lifecycle id for this completed message block. */
  messageId: string;
  /** Namespace disambiguates model lifecycle ids reused by child scopes. */
  namespace: string[];
  text: string;
};

export type LocalAgentMessageCompletedEvent = {
  type: 'message.completed';
  requestId: string;
  role: 'assistant';
  text: string;
  usage?: TokenUsageSnapshot;
};

export type LocalAgentOperationPhase =
  | 'started'
  | 'updated'
  | 'completed'
  | 'failed'
  | 'interrupted';

export type LocalAgentOperationRaw = {
  input?: unknown;
  output?: unknown;
  error?: unknown;
};

export type LocalAgentOperationEvent = {
  type: 'operation';
  requestId: string;
  phase: LocalAgentOperationPhase;
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
   * Raw tool-call input/output/error. Only forwarded over trusted local
   * transports (e.g. 127.0.0.1 TUI/companion socket). Stripped before sending
   * to remote app channels — remote UI must rely on operation.summary/details.
   */
  raw?: LocalAgentOperationRaw;
};

export type LocalAgentHumanReviewRequestedEvent = {
  type: 'human_review.requested';
  requestId: string;
  interruptId?: string;
  review: ReviewSpec;
  reviews?: ReviewSpec[];
  actor?: {
    petId?: string;
  };
};

export type LocalAgentStudioProgressEvent = {
  type: 'studio.progress';
  requestId: string;
  event: Record<string, unknown>;
};

export type LocalAgentSystemNoticeEvent = {
  type: 'system.notice';
  requestId: string;
  message: string;
};

export type LocalAgentErrorCode =
  | 'review_closed'
  | 'review_stale'
  | 'review_wrong_session';

export type LocalAgentErrorEvent = {
  type: 'error';
  requestId: string;
  message: string;
  code?: LocalAgentErrorCode;
};
