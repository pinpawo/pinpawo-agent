import type { LocalAgentRuntimeEvent } from '../../events/localAgentEvent';
import type { LocalAgentRun, LocalAgentSession } from '../../localAgentSession';
import {
  applySessionSnapshot,
  reduceSession,
  type LocalAgentSessionInput,
  type LocalAgentSessionMessageInput,
} from '../../localAgentSessionReducer';
import { currentReview } from '../../reviewAction';
import {
  navigateComposerHistory,
  recordComposerHistoryEntry,
  resetComposerHistoryNavigation,
} from '../input/composerHistory';
import {
  formatStudioProgressEvent,
  formatSystemNoticeEvent,
} from '../render/eventText';
import { TUI_TEXT } from '../render/text';
import { selectActiveOperationsFromTimeline } from '../timeline/agentTimelineSelectors';
import type {
  MessageCellDraft,
  MessageCellMeta,
  MessageCellModel,
  RunId,
  SessionId,
  SessionModel,
  TuiAction,
  TuiRunModel,
  TuiState,
} from './tuiState';
import { createSession } from './tuiState';

function resolveSessionId(state: TuiState, sessionId?: SessionId) {
  return sessionId ?? state.focusedSessionId;
}

function updateSession(
  state: TuiState,
  sessionId: SessionId | null,
  update: (session: SessionModel) => SessionModel,
) {
  if (!sessionId) return state;
  const session = state.sessions[sessionId];
  if (!session) return state;
  const nextSession = update(session);
  if (nextSession === session) return state;
  return {
    ...state,
    sessions: { ...state.sessions, [sessionId]: nextSession },
  };
}

function normalizeTuiSession(
  session: LocalAgentSession,
  fallback: SessionModel,
): SessionModel {
  return {
    ...session,
    actor: session.actor ?? fallback.actor,
    runtime: session.runtime ?? fallback.runtime,
  };
}

function applySessionInput(
  state: TuiState,
  sessionId: SessionId | null,
  input: LocalAgentSessionInput,
  observedAt: number,
) {
  return updateSession(state, sessionId, (session) => {
    const reduced = reduceSession(session, input, { observedAt });
    return reduced === session ? session : normalizeTuiSession(reduced, session);
  });
}

function findSessionForRun(state: TuiState, requestId: string) {
  for (const [sessionId, session] of Object.entries(state.sessions)) {
    if (session.activeRun?.requestId === requestId) return { sessionId, session };
  }
  return null;
}

function findSessionForTimelineRequest(state: TuiState, requestId: string) {
  for (const [sessionId, session] of Object.entries(state.sessions)) {
    if (session.timeline.some((entry) => entry.requestId === requestId)) {
      return { sessionId, session };
    }
  }
  return null;
}

function findSessionForRuntimeEvent(state: TuiState, event: LocalAgentRuntimeEvent) {
  return findSessionForRun(state, event.requestId)
    ?? (event.type === 'message.completed'
      ? findSessionForTimelineRequest(state, event.requestId)
      : null);
}

function messageInputFromDraft(draft: MessageCellDraft): LocalAgentSessionMessageInput {
  return {
    id: `message:${draft.id}`,
    role: draft.kind,
    text: draft.text,
    source: draft.kind === 'user' ? 'local-input' : 'live-event',
    ...(draft.requestId ? { requestId: draft.requestId } : {}),
    ...(draft.timestamp ? { createdAt: draft.timestamp } : {}),
  };
}

function messageInput(
  role: MessageCellModel['kind'],
  text: string,
  meta: MessageCellMeta | undefined,
  fallbackId: string,
  requestId?: string,
): LocalAgentSessionMessageInput {
  return {
    id: `message:${meta?.id ?? fallbackId}`,
    role,
    text,
    source: role === 'user' ? 'local-input' : 'live-event',
    ...(requestId ? { requestId } : {}),
    ...(meta?.timestamp ? { createdAt: meta.timestamp } : {}),
  };
}

function runtimeMessageInput(
  event: LocalAgentRuntimeEvent,
  meta: MessageCellMeta | undefined,
): LocalAgentSessionMessageInput | undefined {
  switch (event.type) {
    case 'message.delta':
    case 'message.completed':
      return {
        role: 'assistant',
        requestId: event.requestId,
        text: event.text,
        source: 'live-event',
        ...(meta?.timestamp ? { createdAt: meta.timestamp } : {}),
      };
    case 'system.notice': {
      const text = formatSystemNoticeEvent(event);
      return text
        ? messageInput('system', text, meta, `${event.requestId}:notice`, event.requestId)
        : undefined;
    }
    case 'studio.progress': {
      const text = formatStudioProgressEvent(event);
      return text
        ? messageInput('system', text, meta, `${event.requestId}:studio-progress`, event.requestId)
        : undefined;
    }
    case 'error':
      return messageInput(
        'system',
        TUI_TEXT.errorLine(event.message || 'internal error'),
        meta,
        `${event.requestId}:event-error`,
        event.requestId,
      );
    default:
      return undefined;
  }
}

function removeReviewDraft(state: TuiState, actionId: string | undefined) {
  if (!actionId || !state.reviewDrafts[actionId]) return state;
  const { [actionId]: _removed, ...reviewDrafts } = state.reviewDrafts;
  void _removed;
  return { ...state, reviewDrafts };
}

function clearTextAreaTransientInputState(input: TuiState['input']): TuiState['input'] {
  return {
    ...input,
    selection: undefined,
    editHistory: undefined,
    preferredColumn: undefined,
  };
}

function reduceRuntimeEvent(
  state: TuiState,
  action: Extract<TuiAction, { type: 'event.received' }>,
) {
  const event = action.event;
  const owner = findSessionForRuntimeEvent(state, event);
  if (!owner) return state;
  const previousRun = owner.session.activeRun?.requestId === event.requestId
    ? owner.session.activeRun
    : null;
  const previousReviewActionId = previousRun?.reviewAction?.actionId;
  const message = runtimeMessageInput(event, action.messageCell);
  const nextState = applySessionInput(state, owner.sessionId, {
    type: 'runtime.event',
    event,
    ...(message ? { message } : {}),
  }, action.now);
  if (nextState === state) return state;

  let next = nextState;
  if (event.type === 'human_review.requested') {
    const reviewAction = next.sessions[owner.sessionId]?.activeRun?.reviewAction;
    next = removeReviewDraft(next, previousReviewActionId);
    if (reviewAction) {
      next = {
        ...next,
        reviewDrafts: {
          ...next.reviewDrafts,
          [reviewAction.actionId]: {
            actionId: reviewAction.actionId,
            decisions: [],
          },
        },
        connection: {
          ...next.connection,
          message: TUI_TEXT.approvalWaiting(reviewAction.petId),
        },
      };
    }
  } else if (event.type === 'message.completed') {
    next = {
      ...removeReviewDraft(next, previousReviewActionId),
      connection: { ...next.connection, message: TUI_TEXT.statusReady },
    };
  } else if (event.type === 'error') {
    next = {
      ...removeReviewDraft(next, previousReviewActionId),
      connection: { ...next.connection, message: TUI_TEXT.statusErrorRecovered },
    };
  }
  return next;
}

function applyLoadedSessionSnapshot(
  state: TuiState,
  action: Extract<TuiAction, { type: 'session.snapshot.loaded' }>,
) {
  const incoming = action.snapshot.session;
  const existingSession = state.sessions[incoming.sessionId];
  const focusedSession = state.focusedSessionId
    ? state.sessions[state.focusedSessionId]
    : undefined;
  const baseSession = existingSession
    ?? focusedSession
    ?? createSession({ id: incoming.sessionId, kind: incoming.kind });
  const appliedSession = normalizeTuiSession(
    applySessionSnapshot(
      baseSession,
      action.snapshot,
      {
        observedAt: action.now ?? 0,
        preserveOmittedTokenUsage:
          action.reason === 'reconnect'
          || action.reason === 'completion'
          || action.reason === 'review-refresh',
      },
    ),
    baseSession,
  );
  const sessions = { ...state.sessions, [incoming.sessionId]: appliedSession };
  const reviewDrafts = { ...state.reviewDrafts };

  const previousActionId = existingSession?.activeRun?.reviewAction?.actionId;
  if (previousActionId) delete reviewDrafts[previousActionId];
  const incomingReviewAction = appliedSession.activeRun?.reviewAction;
  if (incomingReviewAction?.reviews.length) {
    reviewDrafts[incomingReviewAction.actionId] = {
      actionId: incomingReviewAction.actionId,
      decisions: [],
    };
  }

  if (action.reason === 'resume' && state.focusedSessionId !== incoming.sessionId) {
    const previousFocused = state.focusedSessionId
      ? sessions[state.focusedSessionId]
      : undefined;
    if (previousFocused?.activeRun) {
      const previousFocusedActionId = previousFocused.activeRun.reviewAction?.actionId;
      if (previousFocusedActionId) delete reviewDrafts[previousFocusedActionId];
      sessions[previousFocused.sessionId] = normalizeTuiSession(reduceSession(previousFocused, {
        type: 'run.finished',
        requestId: previousFocused.activeRun.requestId,
      }, { observedAt: action.now ?? 0 }), previousFocused);
    }
  }

  return {
    ...state,
    sessions,
    reviewDrafts,
    focusedSessionId: incoming.sessionId,
    ui: action.reason === 'resume'
      ? { mode: 'chat' as const, studioConversationId: null, externalEditorOpen: false }
      : state.ui,
  };
}

function finishRun(
  state: TuiState,
  requestId: string,
  statusMessage: string,
  messages: LocalAgentSessionMessageInput[] = [],
  observedAt = 0,
) {
  const owner = findSessionForRun(state, requestId);
  if (!owner) return state;
  const actionId = owner.session.activeRun?.reviewAction?.actionId;
  const nextState = applySessionInput(state, owner.sessionId, {
    type: 'run.finished',
    requestId,
    messages,
  }, observedAt);
  const withoutDraft = removeReviewDraft(nextState, actionId);
  return {
    ...withoutDraft,
    connection: { ...withoutDraft.connection, message: statusMessage },
  };
}

function countRunOutputChars(session: SessionModel, requestId: string) {
  return session.timeline.reduce((count, entry) => (
    entry.type === 'message'
      && entry.requestId === requestId
      && (entry.role === 'assistant' || entry.role === 'subagent')
      ? count + entry.text.length
      : count
  ), 0);
}

function activeRunToPendingUi(session: SessionModel, run: LocalAgentRun | null) {
  if (!run || run.phase === 'waiting_human') return null;
  return {
    startedAt: run.startedAt ?? 0,
    phase: run.phase === 'interrupting'
      ? 'interrupting' as const
      : run.phase === 'streaming'
        ? 'replying' as const
        : 'thinking' as const,
    charCount: countRunOutputChars(session, run.requestId),
  };
}

function activeRunToPendingApproval(state: TuiState, run: TuiRunModel | null) {
  if (!run?.reviewAction || run.reviewAction.status !== 'waiting') return null;
  const draft = state.reviewDrafts[run.reviewAction.actionId];
  if (!draft) return null;
  const review = currentReview(run.reviewAction, draft);
  if (!review) return null;
  return {
    requestId: run.requestId,
    ...run.reviewAction,
    review,
    decisions: draft.decisions,
  };
}

export function tuiStateReducer(state: TuiState, action: TuiAction): TuiState {
  switch (action.type) {
    case 'session.snapshot.loaded':
      return applyLoadedSessionSnapshot(state, action);
    case 'connection.set':
      return {
        ...state,
        connection: { status: action.status, message: action.message },
      };
    case 'session.set_actor':
      return applySessionInput(state, resolveSessionId(state, action.sessionId), {
        type: 'session.configured',
        actor: action.actor,
      }, 0);
    case 'session.set_runtime':
      return applySessionInput(state, resolveSessionId(state, action.sessionId), {
        type: 'session.configured',
        runtime: action.runtime,
      }, 0);
    case 'session.set_kind':
      return applySessionInput(state, resolveSessionId(state, action.sessionId), {
        type: 'session.configured',
        kind: action.kind,
      }, 0);
    case 'session.clear': {
      const sessionId = resolveSessionId(state, action.sessionId);
      const actionId = sessionId
        ? state.sessions[sessionId]?.activeRun?.reviewAction?.actionId
        : undefined;
      const nextState = applySessionInput({
        ...state,
        ui: { mode: 'chat', studioConversationId: null, externalEditorOpen: false },
        connection: action.statusMessage
          ? { ...state.connection, message: action.statusMessage }
          : state.connection,
      }, sessionId, { type: 'session.cleared' }, 0);
      return removeReviewDraft(nextState, actionId);
    }
    case 'ui.mode.set':
      return {
        ...state,
        ui: {
          ...state.ui,
          mode: action.mode,
          studioConversationId: action.mode === 'studio'
            ? action.studioConversationId ?? state.ui.studioConversationId
            : null,
        },
      };
    case 'ui.mode.reset':
      return {
        ...state,
        ui: { ...state.ui, mode: 'chat', studioConversationId: null },
      };
    case 'ui.external_editor.set_open':
      return {
        ...state,
        ui: { ...state.ui, externalEditorOpen: action.open },
      };
    case 'input.set':
      return {
        ...state,
        input: clearTextAreaTransientInputState({
          ...state.input,
          text: action.value,
          cursorOffset: action.cursorOffset ?? action.value.length,
          history: resetComposerHistoryNavigation(state.input.history),
        }),
      };
    case 'input.apply':
      return {
        ...state,
        input: {
          ...state.input,
          text: action.value.text,
          cursorOffset: action.value.cursorOffset,
          selection: action.value.selection,
          editHistory: action.value.editHistory,
          preferredColumn: action.value.preferredColumn,
          history: resetComposerHistoryNavigation(state.input.history),
        },
      };
    case 'input.history.navigate': {
      const result = navigateComposerHistory(state.input.history, state.input.text, action.direction);
      return {
        ...state,
        input: clearTextAreaTransientInputState({
          ...state.input,
          text: result.value,
          cursorOffset: result.value.length,
          history: result.history,
        }),
      };
    }
    case 'message.append':
      return applySessionInput(state, resolveSessionId(state, action.sessionId), {
        type: 'message.appended',
        message: messageInputFromDraft(action.cell),
      }, 0);
    case 'run.start': {
      const sessionId = resolveSessionId(state, action.sessionId);
      if (!sessionId) return state;
      const previousActionId = state.sessions[sessionId]?.activeRun?.reviewAction?.actionId;
      const nextState = applySessionInput({
        ...state,
        connection: { ...state.connection, message: action.statusMessage },
        input: clearTextAreaTransientInputState({
          ...state.input,
          text: '',
          cursorOffset: 0,
          history: recordComposerHistoryEntry(state.input.history, action.userText),
        }),
      }, sessionId, {
        type: 'user.accepted',
        requestId: action.requestId,
        kind: action.kind,
        text: action.userText,
        message: {
          id: `message:${action.userCell.id}`,
          ...(action.userCell.timestamp ? { createdAt: action.userCell.timestamp } : {}),
        },
      }, action.now);
      return removeReviewDraft(nextState, previousActionId);
    }
    case 'review.draft.record': {
      const owner = findSessionForRun(state, action.requestId);
      const reviewAction = owner?.session.activeRun?.reviewAction;
      if (!reviewAction || reviewAction.actionId !== action.actionId) return state;
      const draft = state.reviewDrafts[action.actionId]
        ?? { actionId: action.actionId, decisions: [] };
      return {
        ...state,
        reviewDrafts: {
          ...state.reviewDrafts,
          [action.actionId]: {
            ...draft,
            decisions: [...draft.decisions, action.decision],
          },
        },
        connection: { ...state.connection, message: action.statusMessage },
        input: clearTextAreaTransientInputState({
          ...state.input,
          text: '',
          cursorOffset: 0,
          history: resetComposerHistoryNavigation(state.input.history),
        }),
      };
    }
    case 'review.action.submit': {
      const owner = findSessionForRun(state, action.requestId);
      const reviewAction = owner?.session.activeRun?.reviewAction;
      if (!owner || !reviewAction || reviewAction.actionId !== action.actionId) return state;
      const draft = state.reviewDrafts[action.actionId]
        ?? { actionId: action.actionId, decisions: [] };
      const nextState = applySessionInput({
        ...state,
        reviewDrafts: {
          ...state.reviewDrafts,
          [action.actionId]: {
            ...draft,
            decisions: [...draft.decisions, action.decision],
          },
        },
        connection: { ...state.connection, message: action.statusMessage },
        input: clearTextAreaTransientInputState({
          ...state.input,
          text: '',
          cursorOffset: 0,
          history: resetComposerHistoryNavigation(state.input.history),
        }),
      }, owner.sessionId, {
        type: 'review.submitted',
        requestId: action.requestId,
        actionId: action.actionId,
      }, 0);
      return nextState;
    }
    case 'review.action.cancel': {
      const owner = findSessionForRun(state, action.requestId);
      if (!owner) return state;
      const nextState = applySessionInput(state, owner.sessionId, {
        type: 'review.canceled',
        requestId: action.requestId,
        actionId: action.actionId,
      }, 0);
      return nextState === state
        ? state
        : { ...nextState, connection: { ...nextState.connection, message: action.statusMessage } };
    }
    case 'run.interrupting':
    case 'server.interrupting': {
      const owner = findSessionForRun(state, action.requestId);
      if (!owner) return state;
      const actionId = owner.session.activeRun?.reviewAction?.actionId;
      const nextState = applySessionInput(state, owner.sessionId, {
        type: 'run.interrupting',
        requestId: action.requestId,
      }, 0);
      const withoutDraft = removeReviewDraft(nextState, actionId);
      return {
        ...withoutDraft,
        connection: { ...withoutDraft.connection, message: action.statusMessage },
      };
    }
    case 'run.finish':
      return finishRun(
        state,
        action.requestId,
        action.statusMessage,
        action.messages?.map(messageInputFromDraft),
      );
    case 'event.received':
      return reduceRuntimeEvent(state, action);
    case 'server.interrupted':
      return finishRun(state, action.requestId, action.statusMessage, [
        messageInput(
          'assistant',
          TUI_TEXT.interrupted,
          action.messageCell,
          `${action.requestId}:interrupted`,
          action.requestId,
        ),
      ]);
    case 'server.studio_response': {
      const messages = [
        action.reply.trim()
          ? messageInput(
              'assistant',
              action.reply.trim(),
              action.messageCell,
              `${action.requestId}:studio-response`,
              action.requestId,
            )
          : messageInput(
              'system',
              TUI_TEXT.studioEmptyTurn(action.outcome),
              action.messageCell,
              `${action.requestId}:studio-empty`,
              action.requestId,
            ),
      ];
      if (action.outcome === 'stopped' && action.reason) {
        messages.push(messageInput(
          'system',
          TUI_TEXT.studioStoppedReason(action.reason),
          action.stoppedReasonCell,
          `${action.requestId}:studio-stopped`,
          action.requestId,
        ));
      }
      return finishRun(state, action.requestId, action.statusMessage, messages);
    }
    case 'server.studio_error':
      return finishRun(state, action.requestId, action.statusMessage, [
        messageInput(
          'system',
          TUI_TEXT.studioErrorLine(action.message || 'studio error'),
          action.messageCell,
          `${action.requestId}:studio-error`,
          action.requestId,
        ),
      ]);
    default:
      return state;
  }
}

export function selectFocusedSession(state: TuiState) {
  return state.focusedSessionId ? state.sessions[state.focusedSessionId] ?? null : null;
}

export function selectFocusedTimeline(state: TuiState) {
  return selectFocusedSession(state)?.timeline ?? [];
}

export function selectFocusedActiveRun(state: TuiState) {
  return selectFocusedSession(state)?.activeRun ?? null;
}

export function selectFocusedBusy(state: TuiState) {
  const activeRun = selectFocusedActiveRun(state);
  return Boolean(activeRun && activeRun.phase !== 'waiting_human');
}

export function selectFocusedPendingUi(state: TuiState) {
  const session = selectFocusedSession(state);
  return session ? activeRunToPendingUi(session, session.activeRun) : null;
}

export function selectFocusedActiveOperations(state: TuiState) {
  const session = selectFocusedSession(state);
  const activeRun = selectFocusedActiveRun(state);
  return session && activeRun
    ? selectActiveOperationsFromTimeline(session.timeline, activeRun.requestId)
    : [];
}

export function selectFocusedPendingApproval(state: TuiState) {
  return activeRunToPendingApproval(state, selectFocusedActiveRun(state));
}

export function selectReady(state: TuiState) {
  return state.connection.status === 'ready';
}
