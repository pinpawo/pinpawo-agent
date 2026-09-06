import type {
  AgentSession,
  ReviewResponse,
} from '@pinpawo/agent-session';
import type {
  AgentHostConnectionFactory,
} from '../client/localHostConnection';
import type { SessionSnapshotReason } from './sessionSnapshot';

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
  /** TUI-owned request state for session commands that do not create an agent run. */
  pendingSessionCommand?: 'compact';
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
      responses: ReviewResponse[];
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
  /** Manual compaction includes a model call and therefore needs a longer timeout. */
  sessionCompactTimeoutMs?: number;
  /** Called before a manually requested canonical snapshot updates UI state. */
  onManualSnapshotApplied?: (reason: Extract<SessionSnapshotReason, 'manual'>) => void;
  setTimer?: (callback: () => void, delayMs: number) => TimerHandle;
  clearTimer?: (timer: TimerHandle) => void;
};
