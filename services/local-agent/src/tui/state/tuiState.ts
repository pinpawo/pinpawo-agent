import type { ReviewResponse, ReviewSpec, TokenUsageSnapshot } from '@pinpawo/pet-agent';
import type { LocalAgentEvent } from '../../events/localAgentEvent';
import type { TuiCoreSessionSnapshotLoadedAction } from '../contracts/tuiCoreContract';
import type { AgentTimelineEntry } from '../timeline/agentTimeline';
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
  message: string;
};

export type TuiState = {
  connection: TuiConnectionState;
  sessions: Record<SessionId, SessionModel>;
  focusedSessionId: SessionId | null;
  runs: Record<RunId, TuiRunModel>;
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

export type SessionModel = {
  id: SessionId;
  kind: 'chat' | 'studio';
  actor: {
    label: string;
    summary: string;
  };
  runtime: {
    model?: string;
    cwd?: string;
    workspaceId?: string;
    workspaceName?: string;
    workspaceRoot?: string;
    stateRoot?: string;
    studioConfigPath?: string;
    studioDueRunsPath?: string;
    studioConfigSource?: string;
    studioConfigActivePath?: string;
    legacyStudioConfigPath?: string;
    petsDir?: string;
    studioWikiBaseDir?: string;
    contextWindow?: number;
  };
  timeline: AgentTimelineEntry[];
  activeRunId: RunId | null;
  tokenUsage: TokenUsageModel | null;
};

export type ActiveRunModel = {
  requestId: RunId;
  phase: 'thinking' | 'using_tool' | 'streaming' | 'waiting_human' | 'interrupting';
  timelineEntryIds: string[];
  pendingReview?: ApprovalRequestModel;
  startedAt: number;
  charCount: number;
};

export type TuiRunModel = ActiveRunModel & {
  sessionId: SessionId;
  kind: SessionModel['kind'];
};

export type TokenUsageModel = TokenUsageSnapshot;

export type MessageCellModel = {
  id: string;
  kind: 'user' | 'assistant' | 'system';
  text: string;
  requestId?: RunId;
  timestamp?: string;
};

export type ApprovalRequestModel = {
  requestId: RunId;
  review: ReviewSpec;
  reviews: ReviewSpec[];
  reviewIndex: number;
  decisions: ReviewResponse[];
  petId?: string;
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

export type TuiAction =
  | TuiCoreSessionSnapshotLoadedAction
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
      type: 'review.response.resume';
      requestId: RunId;
      message: string;
      now: number;
      userCell: MessageCellMeta;
      statusMessage: string;
    }
  | {
      type: 'review.action.advance';
      requestId: RunId;
      decision: ReviewResponse;
      message: string;
      now: number;
      userCell: MessageCellMeta;
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
      event: LocalAgentEvent;
      now: number;
      messageCell?: MessageCellMeta;
    }
  | {
      type: 'server.interrupting';
      requestId: RunId;
      statusMessage: string;
    }
  | {
      type: 'server.interrupted';
      requestId: RunId;
      messageCell: MessageCellMeta;
      statusMessage: string;
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
      [defaultSession.id]: defaultSession,
    },
    focusedSessionId: defaultSession.id,
    runs: {},
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
  timeline?: AgentTimelineEntry[];
}): SessionModel {
  return {
    id: params.id,
    kind: params.kind ?? 'chat',
    actor: {
      label: params.actor?.label ?? TUI_TEXT.defaultPetName,
      summary: params.actor?.summary ?? TUI_TEXT.defaultPetSummary,
    },
    runtime: {},
    timeline: params.timeline ?? [],
    activeRunId: null,
    tokenUsage: null,
  };
}
