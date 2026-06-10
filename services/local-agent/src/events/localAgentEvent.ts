import type { ReviewSpec } from '@pinpawo/pet-agent';

export type LocalAgentEvent =
  | LocalAgentMessageDeltaEvent
  | LocalAgentMessageCompletedEvent
  | LocalAgentOperationEvent
  | LocalAgentHumanReviewRequestedEvent
  | LocalAgentStudioProgressEvent
  | LocalAgentSystemNoticeEvent
  | LocalAgentErrorEvent;

export type LocalAgentMessageDeltaEvent = {
  type: 'message.delta';
  requestId: string;
  role: 'assistant';
  text: string;
};

export type LocalAgentMessageCompletedEvent = {
  type: 'message.completed';
  requestId: string;
  role: 'assistant';
  text: string;
  usage?: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    contextWindow?: number;
    updatedAt?: string;
  };
  metadata?: {
    mood?: string | null;
    topic?: string | null;
    tags?: string[];
  };
};

export type LocalAgentOperationPhase =
  | 'started'
  | 'updated'
  | 'completed'
  | 'failed'
  | 'interrupted';

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
      provider: 'toolkit' | 'toolset' | 'runtime';
      name: string;
      toolName?: string;
      callId?: string;
    };
  };
};

export type LocalAgentOperationRaw = {
  input?: unknown;
  output?: unknown;
  error?: unknown;
};

export type LocalAgentOperationInternalEvent = LocalAgentOperationEvent & {
  raw?: LocalAgentOperationRaw;
};

export type LocalAgentHumanReviewRequestedEvent = {
  type: 'human_review.requested';
  requestId: string;
  review: ReviewSpec;
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

export type LocalAgentErrorEvent = {
  type: 'error';
  requestId: string;
  message: string;
};
