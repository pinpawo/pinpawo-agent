import type {
  HumanReviewRequest,
  HumanReviewResponse,
  JsonObject,
} from '@pinpawo/agent-contracts';

export type PendingInterruptProjection = {
  interruptId: string;
  payload: {
    kind: 'human_review';
    interactions: HumanReviewRequest[];
  };
};

export type StudioDispatchInput =
  | { kind: 'request'; request: string }
  | {
      kind: 'resume_interrupt';
      interruptId: string;
      payload: {
        kind: 'human_review_response';
        responses: HumanReviewResponse[];
      };
    };

export type StudioDispatchRequest = {
  petId: string;
  input: StudioDispatchInput;
  /** Producer-owned correlation data echoed by Studio; never passed to the Pet runtime. */
  metadata?: JsonObject;
  /** Deduplicates an explicitly retried dispatch for this Pet and Host generation. */
  idempotencyKey?: string;
  signal?: AbortSignal;
};

export type StudioInvocationTerminalStatus =
  | 'completed'
  | 'pending_interrupt'
  | 'failed'
  | 'cancelled';

export type StudioDispatchResult = {
  petId: string;
  threadId: string;
  invocationId: string;
  status: StudioInvocationTerminalStatus;
  metadata?: JsonObject;
  output?: string;
  pendingInterrupt?: PendingInterruptProjection;
  error?: string;
};

/**
 * Immediate acknowledgement of one accepted dispatch. Completion settles when
 * its serialized graph invocation reaches a terminal or durable-wait state.
 */
export type StudioDispatchReceipt = {
  petId: string;
  threadId: string;
  invocationId: string;
  metadata?: JsonObject;
  /**
   * Observe only this invocation. The latest event is replayed immediately so
   * a caller cannot miss progress emitted before the receipt was delivered.
   */
  onInvocation: (handler: StudioInvocationEventHandler) => () => void;
  completion: Promise<StudioDispatchResult>;
};

export type StudioInvocationEvent = {
  petId: string;
  threadId: string;
  invocationId: string;
  status: 'busy' | StudioInvocationTerminalStatus;
  metadata?: JsonObject;
  output?: string;
  pendingInterrupt?: PendingInterruptProjection;
  error?: string;
};

export type StudioInvocationEventHandler =
  (event: StudioInvocationEvent) => void | Promise<void>;

/** One deterministic checkpoint namespace for a resident Studio Pet. */
export function buildStudioPetThreadId(studioId: string, petId: string): string {
  return `studio:${encodeURIComponent(studioId)}:pet:${encodeURIComponent(petId)}`;
}
