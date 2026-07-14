import type { ReviewResponse, ReviewSpec } from '@pinpawo/pet-agent';
import type { LocalAgentRuntimeEvent } from '../../events/localAgentRuntimeEvent';
import type {
  LocalAgentActorView,
  LocalAgentReviewAction,
  LocalAgentRuntimeView,
  LocalAgentSession,
  LocalAgentSessionSnapshot,
  LocalAgentTimelineEntry,
} from '../../localAgentSession';
import {
  createComposerHistoryState,
  type ComposerHistoryDirection,
  type ComposerHistoryState,
} from '../input/composerHistory';
import type { TextAreaModel } from '../input/textarea/engine';
import { TUI_TEXT } from '../render/text';
import type { ReviewDraft } from '../../reviewAction';

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
  message: string;
};

export type TuiState = {
  connection: TuiConnectionState;
  sessions: Record<SessionId, SessionModel>;
  focusedSessionId: SessionId | null;
  reviewDrafts: Record<string, ReviewDraft>;
  ui: TuiUiState;
  input: TextAreaModel & {
    focused: boolean;
    history: ComposerHistoryState;
  };
};

export type TuiInteractionMode = 'chat' | 'studio';

export type TuiUiState = {
  mode: TuiInteractionMode;
  studioConversationId: string | null;
  externalEditorOpen: boolean;
};

export type SessionModel = Omit<
  LocalAgentSession,
  'actor' | 'runtime'
> & {
  actor: LocalAgentActorView;
  runtime: LocalAgentRuntimeView;
};

export type MessageCellModel = {
  id: string;
  kind: 'user' | 'assistant' | 'system';
  text: string;
  requestId?: RunId;
  timestamp?: string;
};

export type ApprovalRequestModel = LocalAgentReviewAction & {
  requestId: RunId;
  review: ReviewSpec;
  decisions: ReviewResponse[];
};

export type MessageCellDraft = {
  id: string;
  kind: MessageCellModel['kind'];
  text: string;
  requestId?: RunId;
  timestamp?: string;
};

export type MessageCellMeta = {
  id: string;
  timestamp?: string;
};

export type TuiSnapshotApplyReason =
  | 'startup'
  | 'reconnect'
  | 'resume'
  | 'completion'
  | 'review-refresh';

export type TuiAction =
  | {
      type: 'session.snapshot.loaded';
      reason: TuiSnapshotApplyReason;
      snapshot: LocalAgentSessionSnapshot;
      now?: number;
    }
  | {
      type: 'connection.set';
      status: TuiConnectionStatus;
      message: string;
    }
  | {
      type: 'session.set_actor';
      sessionId?: SessionId;
      actor: SessionModel['actor'];
    }
  | {
      type: 'session.set_runtime';
      sessionId?: SessionId;
      runtime: Partial<SessionModel['runtime']>;
    }
  | {
      type: 'session.set_kind';
      sessionId?: SessionId;
      kind: SessionModel['kind'];
    }
  | {
      type: 'session.clear';
      sessionId?: SessionId;
      statusMessage?: string;
    }
  | {
      type: 'ui.mode.set';
      mode: TuiInteractionMode;
      studioConversationId?: string | null;
    }
  | {
      type: 'ui.mode.reset';
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
      type: 'message.append';
      sessionId?: SessionId;
      cell: MessageCellDraft;
    }
  | {
      type: 'run.start';
      sessionId?: SessionId;
      requestId: RunId;
      kind: SessionModel['kind'];
      userText: string;
      now: number;
      userCell: MessageCellMeta;
      statusMessage: string;
    }
  | {
      // The user answered a HITL review. Server resumes the same LangGraph
      // run from its checkpoint, so this is modeled as resuming the existing
      // activeRun (phase: 'waiting_human' → 'thinking'), not starting a new
      // run. requestId stays the same as the human_review.requested it
      // answers.
      type: 'review.action.submit';
      requestId: RunId;
      actionId: string;
      decision: ReviewResponse;
      statusMessage: string;
    }
  | {
      type: 'review.draft.record';
      requestId: RunId;
      actionId: string;
      decision: ReviewResponse;
      statusMessage: string;
    }
  | {
      type: 'review.action.cancel';
      requestId: RunId;
      actionId: string;
      statusMessage: string;
    }
  | {
      type: 'run.interrupting';
      requestId: RunId;
      statusMessage: string;
    }
  | {
      type: 'run.finish';
      requestId: RunId;
      statusMessage: string;
      messages?: MessageCellDraft[];
    }
  | {
      type: 'event.received';
      event: LocalAgentRuntimeEvent;
      now: number;
      messageCell?: MessageCellMeta;
    }
  | {
      type: 'server.studio_response';
      requestId: RunId;
      outcome: 'done' | 'stopped';
      reply: string;
      reason?: string;
      messageCell: MessageCellMeta;
      stoppedReasonCell?: MessageCellMeta;
      statusMessage: string;
    }
  | {
      type: 'server.studio_error';
      requestId: RunId;
      message: string;
      messageCell: MessageCellMeta;
      statusMessage: string;
    };

export function createInitialTuiState(defaultSession: SessionModel): TuiState {
  return {
    connection: {
      status: 'initializing',
      message: TUI_TEXT.statusInitializing,
    },
    sessions: {
      [defaultSession.sessionId]: defaultSession,
    },
    focusedSessionId: defaultSession.sessionId,
    reviewDrafts: {},
    ui: {
      mode: 'chat',
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
  timeline?: LocalAgentTimelineEntry[];
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
