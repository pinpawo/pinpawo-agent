import type {
  AgentSession,
  ReviewResponse,
} from '@pinpawo/agent-session';
import type {
  AgentHostConnectionFactory,
} from '../client/localHostConnection';

type TimerHandle = ReturnType<typeof setTimeout>;

export type TuiConnectionStatus =
  | 'idle'
  | 'connecting'
  | 'reconnecting'
  | 'ready'
  | 'disconnected'
  | 'error';

export type TuiSessionState = {
  connection: TuiConnectionStatus;
  connectionDetail?: string;
  session: AgentSession;
};

export type SubmitChatResult =
  | { ok: true; requestId: string }
  | {
      ok: false;
      reason:
        | 'not-ready'
        | 'busy'
        | 'empty'
        | 'send-failed';
    };

export type InterruptRunResult =
  | { ok: true; requestId: string }
  | {
      ok: false;
      reason:
        | 'not-ready'
        | 'idle'
        | 'review-active'
        | 'already-interrupting'
        | 'send-failed';
    };

export type InterruptResolvedReviewResult =
  | { ok: true; requestId: string }
  | {
      ok: false;
      reason: 'not-ready' | 'closed' | 'stale' | 'send-failed';
    };

export type SubmitReviewResponseResult =
  | {
      ok: true;
      status: 'advanced' | 'sent';
      decision: ReviewResponse;
      decisions: ReviewResponse[];
    }
  | {
      ok: false;
      reason:
        | 'not-ready'
        | 'closed'
        | 'stale'
        | 'input-required'
        | 'send-failed';
    };

export type CancelReviewResult =
  | { ok: true }
  | {
      ok: false;
      reason: 'not-ready' | 'closed' | 'stale' | 'send-failed';
    };

export type TuiSessionControllerOptions = {
  connectionFactory: AgentHostConnectionFactory;
  now?: () => number;
  requestIdFactory?: () => string;
  reconnectDelaysMs?: readonly number[];
  snapshotTimeoutMs?: number;
  sessionCommandTimeoutMs?: number;
  setTimer?: (callback: () => void, delayMs: number) => TimerHandle;
  clearTimer?: (timer: TimerHandle) => void;
};
