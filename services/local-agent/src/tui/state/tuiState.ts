import type { ReviewSpec } from '@pinpawo/pet-agent';
import type { LocalAgentEvent } from '../../events/localAgentEvent';
import {
  createComposerHistoryState,
  type ComposerHistoryState,
} from '../input/composerHistory';
import type { TextAreaModel } from '../input/textarea/engine';
import { TUI_TEXT } from '../render/text';

export const MAX_TUI_HISTORY_ITEMS = 240;

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
  runRoute: Record<RunId, SessionId>;
  input: TextAreaModel & {
    focused: boolean;
    history: ComposerHistoryState;
  };
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
    contextWindow?: number;
  };
  history: HistoryCellModel[];
  activeRun: ActiveRunModel | null;
  tokenUsage: TokenUsageModel | null;
};

export type ActiveRunModel = {
  requestId: RunId;
  phase: 'thinking' | 'using_tool' | 'streaming' | 'waiting_human' | 'interrupting';
  assistantDraft: string;
  subagentDraft: string;
  activeOperations: ActiveOperationModel[];
  pendingReview?: ApprovalRequestModel;
  startedAt: number;
  charCount: number;
};

export type TokenUsageModel = {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  contextWindow?: number;
  updatedAt?: string;
};

export type HistoryCellModel = {
  id: string;
  kind: 'user' | 'assistant' | 'system';
  text: string;
  timestamp?: string;
};

export type ActiveOperationModel = {
  key: string;
  kind: string;
  title: string;
  detail: string;
  startedAt: number;
};

export type ApprovalRequestModel = {
  requestId: RunId;
  review: ReviewSpec;
  petId?: string;
};

export type HistoryCellDraft = {
  id: string;
  kind: HistoryCellModel['kind'];
  text: string;
  timestamp?: string;
};

export type HistoryCellMeta = {
  id: string;
  timestamp?: string;
};

export type TuiAction =
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
      runtime: Pick<SessionModel['runtime'], 'model' | 'cwd' | 'contextWindow'>;
    }
  | {
      type: 'session.set_kind';
      sessionId?: SessionId;
      kind: SessionModel['kind'];
    }
  | {
      type: 'session.replace_history';
      sessionId?: SessionId;
      history: HistoryCellModel[];
    }
  | {
      type: 'session.clear';
      sessionId?: SessionId;
      statusMessage?: string;
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
      type: 'history.append';
      sessionId?: SessionId;
      cell: HistoryCellDraft;
    }
  | {
      type: 'run.start';
      sessionId?: SessionId;
      requestId: RunId;
      kind: SessionModel['kind'];
      userText: string;
      now: number;
      userCell: HistoryCellMeta;
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
      userCell: HistoryCellMeta;
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
      history?: HistoryCellDraft[];
    }
  | {
      type: 'event.received';
      event: LocalAgentEvent;
      now: number;
      historyCell?: HistoryCellMeta;
    }
  | {
      type: 'server.interrupting';
      requestId: RunId;
      statusMessage: string;
    }
  | {
      type: 'server.interrupted';
      requestId: RunId;
      historyCell: HistoryCellMeta;
      statusMessage: string;
    }
  | {
      type: 'server.studio_response';
      requestId: RunId;
      outcome: 'done' | 'stopped';
      reply: string;
      reason?: string;
      historyCell: HistoryCellMeta;
      stoppedReasonCell?: HistoryCellMeta;
      statusMessage: string;
    }
  | {
      type: 'server.studio_error';
      requestId: RunId;
      message: string;
      historyCell: HistoryCellMeta;
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
    runRoute: {},
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
  history?: HistoryCellModel[];
}): SessionModel {
  return {
    id: params.id,
    kind: params.kind ?? 'chat',
    actor: {
      label: params.actor?.label ?? TUI_TEXT.defaultPetName,
      summary: params.actor?.summary ?? TUI_TEXT.defaultPetSummary,
    },
    runtime: {},
    history: params.history ?? [],
    activeRun: null,
    tokenUsage: null,
  };
}
