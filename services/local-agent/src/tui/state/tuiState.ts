import type { ReviewResponse, ReviewSpec } from '@pinpawo/pet-agent';
import type { AgentRuntimeEvent } from '@pinpawo/agent-session';
import type {
  AgentActorView,
  AgentReviewAction,
  AgentRuntimeView,
  AgentSession,
  AgentSessionMessageInput,
  AgentSessionSnapshot,
  AgentTimelineEntry,
} from '@pinpawo/agent-session';
import type { AgentSessionInput } from '@pinpawo/agent-session';
import type { ReviewDraft } from './reviewDraft';
import {
  createComposerHistoryState,
  type ComposerHistoryDirection,
  type ComposerHistoryState,
} from '../input/composerHistory';
import type { TextAreaModel } from '../input/textarea/engine';
import { TUI_TEXT } from '../render/text';

export type RunId = string;
export type SessionId = string;

export type TuiConnectionStatus =
  | 'initializing'
  | 'connecting'
  | 'ready'
  | 'disconnected'
  | 'error';

export type TuiConnectionState = {
  status: TuiConnectionStatus;
  detail?: string;
};

export type TuiState = {
  connection: TuiConnectionState;
  statusNotice: string | null;
  sessions: Record<SessionId, SessionModel>;
  focusedSessionId: SessionId | null;
  reviewDrafts: Record<string, ReviewDraft>;
  ui: TuiUiState;
  input: TextAreaModel & {
    focused: boolean;
    history: ComposerHistoryState;
  };
};

export type TuiComposerTarget = 'chat' | 'studio';

export type TuiUiState = {
  composerTarget: TuiComposerTarget;
  studioConversationId: string | null;
  externalEditorOpen: boolean;
};

export type SessionModel = Omit<
  AgentSession,
  'actor' | 'runtime'
> & {
  actor: AgentActorView;
  runtime: AgentRuntimeView;
};

export type ApprovalRequestModel = AgentReviewAction & {
  requestId: RunId;
  review: ReviewSpec;
  decisions: ReviewResponse[];
};

export type TuiSnapshotApplyReason =
  | 'startup'
  | 'reconnect'
  | 'resume'
  | 'model-select'
  | 'completion'
  | 'review-refresh';

export type TuiAction =
  | (Extract<
      AgentSessionInput,
      { type: 'session.configured' | 'message.appended' }
    > & { sessionId?: SessionId })
  | {
      type: 'session.snapshot.loaded';
      reason: TuiSnapshotApplyReason;
      snapshot: AgentSessionSnapshot;
      now?: number;
    }
  | {
      type: 'connection.set';
      status: TuiConnectionStatus;
      detail?: string;
    }
  | {
      type: 'session.clear';
      sessionId?: SessionId;
      statusNotice?: string;
    }
  | {
      type: 'ui.composer_target.set';
      composerTarget: TuiComposerTarget;
      studioConversationId?: string | null;
    }
  | {
      type: 'ui.composer_target.reset';
    }
  | {
      type: 'ui.external_editor.set_open';
      open: boolean;
    }
  | {
      type: 'input.set';
      value: string;
      cursorOffset?: number;
    }
  | {
      type: 'input.apply';
      value: TextAreaModel;
    }
  | {
      type: 'input.history.navigate';
      direction: ComposerHistoryDirection;
    }
  | {
      type: 'run.start';
      sessionId?: SessionId;
      requestId: RunId;
      kind: SessionModel['kind'];
      message: AgentSessionMessageInput & { role: 'user' };
      now: number;
    }
  | {
      // A review resolution is a one-shot command. The TUI records only that
      // it was sent, while the shared activeRun remains server-observed until
      // a runtime event or snapshot advances it.
      type: 'review.resolution.sent';
      requestId: RunId;
      actionId: string;
      decision?: ReviewResponse;
    }
  | {
      type: 'review.draft.record';
      requestId: RunId;
      actionId: string;
      decision: ReviewResponse;
    }
  | {
      type: 'run.interrupting';
      requestId: RunId;
    }
  | {
      type: 'run.finish';
      requestId: RunId;
      statusNotice?: string;
      messages?: AgentSessionMessageInput[];
    }
  | {
      type: 'event.received';
      event: AgentRuntimeEvent;
      now: number;
      message?: AgentSessionMessageInput;
    };

export function createInitialTuiState(defaultSession: SessionModel): TuiState {
  return {
    connection: {
      status: 'initializing',
    },
    statusNotice: null,
    sessions: {
      [defaultSession.sessionId]: defaultSession,
    },
    focusedSessionId: defaultSession.sessionId,
    reviewDrafts: {},
    ui: {
      composerTarget: 'chat',
      studioConversationId: null,
      externalEditorOpen: false,
    },
    input: {
      text: '',
      cursorOffset: 0,
      focused: true,
      history: createComposerHistoryState(),
    },
  };
}

export function createSession(params: {
  id: SessionId;
  kind?: SessionModel['kind'];
  actor?: Partial<SessionModel['actor']>;
  timeline?: AgentTimelineEntry[];
}): SessionModel {
  return {
    sessionId: params.id,
    kind: params.kind ?? 'chat',
    actor: {
      label: params.actor?.label ?? TUI_TEXT.defaultPetName,
      summary: params.actor?.summary ?? TUI_TEXT.defaultPetSummary,
    },
    runtime: {},
    timeline: params.timeline ?? [],
    activeRun: null,
  };
}
