import type { AgentRuntimeEvent } from '@pinpawo/agent-session';
import type {
  AgentRunView,
  AgentSession,
  AgentSessionMessageInput,
} from '@pinpawo/agent-session';
import {
  applySessionSnapshot,
  reduceSession,
  type AgentSessionInput,
} from '@pinpawo/agent-session';
import { currentReview } from './reviewDraft';
import {
  navigateComposerHistory,
  recordComposerHistoryEntry,
  resetComposerHistoryNavigation,
} from '../input/composerHistory';
import { TUI_TEXT } from '../render/text';
import { selectActiveOperationsFromTimeline } from '../timeline/agentTimelineSelectors';
import type { RunId, SessionId, SessionModel, TuiAction, TuiState } from './tuiState';
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
  session: AgentSession,
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
  input: AgentSessionInput,
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

function findSessionForRuntimeEvent(state: TuiState, event: AgentRuntimeEvent) {
  return findSessionForRun(state, event.requestId)
    ?? (event.type === 'message.completed'
      ? findSessionForTimelineRequest(state, event.requestId)
      : null);
}

function removeReviewDraft(state: TuiState, actionId: string | undefined) {
  if (!actionId || !state.reviewDrafts[actionId]) return state;
  const { [actionId]: _removed, ...reviewDrafts } = state.reviewDrafts;
  void _removed;
  return { ...state, reviewDrafts };
}

function reviewActionForRun(run: AgentRunView | null | undefined) {
  return run?.state === 'waiting_review' ? run.reviewAction : null;
}

function reviewResolutionWasSent(state: TuiState, run: AgentRunView | null) {
  if (run?.state !== 'waiting_review') return false;
  return state.reviewDrafts[run.reviewAction.actionId]?.resolutionSent === true;
}

function isWaitingForReviewAction(run: AgentRunView | null, actionId: string) {
  return run?.state === 'waiting_review' && run.reviewAction.actionId === actionId;
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
  const previousReviewActionId = reviewActionForRun(previousRun)?.actionId;
  const nextState = applySessionInput(state, owner.sessionId, {
    type: 'runtime.event',
    event,
    ...(action.message ? { message: action.message } : {}),
  }, action.now);
  if (nextState === state) return state;

  let next = nextState;
  if (event.type === 'human_review.requested') {
    const reviewAction = reviewActionForRun(next.sessions[owner.sessionId]?.activeRun);
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
      };
    }
  } else if (
    previousReviewActionId
    && !isWaitingForReviewAction(
      next.sessions[owner.sessionId]?.activeRun ?? null,
      previousReviewActionId,
    )
  ) {
    next = removeReviewDraft(next, previousReviewActionId);
  }

  if (event.type === 'message.completed') {
    const withoutDraft = removeReviewDraft(next, previousReviewActionId);
    next = owner.sessionId === next.focusedSessionId
      ? { ...withoutDraft, statusNotice: null }
      : withoutDraft;
  } else if (event.type === 'error') {
    const withoutDraft = removeReviewDraft(next, previousReviewActionId);
    next = owner.sessionId === next.focusedSessionId
      ? { ...withoutDraft, statusNotice: TUI_TEXT.statusErrorRecovered }
      : withoutDraft;
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
        preserveOmittedSessionTokenUsage:
          action.reason === 'reconnect'
          || action.reason === 'resume'
          || action.reason === 'completion'
          || action.reason === 'review-refresh',
      },
    ),
    baseSession,
  );
  const sessions = { ...state.sessions, [incoming.sessionId]: appliedSession };
  const reviewDrafts = { ...state.reviewDrafts };

  const previousActionId = reviewActionForRun(existingSession?.activeRun)?.actionId;
  if (previousActionId) delete reviewDrafts[previousActionId];
  const incomingReviewAction = reviewActionForRun(appliedSession.activeRun);
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
      const previousFocusedActionId = reviewActionForRun(previousFocused.activeRun)?.actionId;
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
    statusNotice: action.reason === 'resume' ? null : state.statusNotice,
    ui: action.reason === 'resume'
      ? { composerTarget: 'chat' as const, studioConversationId: null, externalEditorOpen: false }
      : state.ui,
  };
}

function finishRun(
  state: TuiState,
  requestId: string,
  statusNotice: string | undefined,
  messages: AgentSessionMessageInput[] = [],
  observedAt = 0,
) {
  const owner = findSessionForRun(state, requestId);
  if (!owner) return state;
  const actionId = reviewActionForRun(owner.session.activeRun)?.actionId;
  const nextState = applySessionInput(state, owner.sessionId, {
    type: 'run.finished',
    requestId,
    messages,
  }, observedAt);
  const withoutDraft = removeReviewDraft(nextState, actionId);
  return {
    ...withoutDraft,
    statusNotice: owner.sessionId === withoutDraft.focusedSessionId
      ? statusNotice ?? null
      : withoutDraft.statusNotice,
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

function activeRunToPendingUi(session: SessionModel, run: AgentRunView | null) {
  if (!run || run.state === 'waiting_review') return null;
  return {
    startedAt: run.startedAt ?? 0,
    phase: run.state === 'interrupting'
      ? 'interrupting' as const
      : run.activity === 'streaming'
        ? 'replying' as const
        : 'thinking' as const,
    charCount: countRunOutputChars(session, run.requestId),
  };
}

function activeRunToPendingApproval(state: TuiState, run: AgentRunView | null) {
  if (run?.state !== 'waiting_review') return null;
  const draft = state.reviewDrafts[run.reviewAction.actionId];
  if (!draft || draft.resolutionSent) return null;
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
        connection: {
          status: action.status,
          ...(action.detail ? { detail: action.detail } : {}),
        },
      };
    case 'session.configured':
    case 'message.appended': {
      const { sessionId, ...input } = action;
      return applySessionInput(
        state,
        resolveSessionId(state, sessionId),
        input,
        0,
      );
    }
    case 'session.clear': {
      const sessionId = resolveSessionId(state, action.sessionId);
      const actionId = sessionId
        ? reviewActionForRun(state.sessions[sessionId]?.activeRun)?.actionId
        : undefined;
      const nextState = applySessionInput({
        ...state,
        ui: { composerTarget: 'chat', studioConversationId: null, externalEditorOpen: false },
        statusNotice: sessionId === state.focusedSessionId
          ? action.statusNotice ?? null
          : state.statusNotice,
      }, sessionId, { type: 'session.cleared' }, 0);
      return removeReviewDraft(nextState, actionId);
    }
    case 'ui.composer_target.set':
      return {
        ...state,
        ui: {
          ...state.ui,
          composerTarget: action.composerTarget,
          studioConversationId: action.composerTarget === 'studio'
            ? action.studioConversationId ?? state.ui.studioConversationId
            : null,
        },
      };
    case 'ui.composer_target.reset':
      return {
        ...state,
        ui: { ...state.ui, composerTarget: 'chat', studioConversationId: null },
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
    case 'run.start': {
      const sessionId = resolveSessionId(state, action.sessionId);
      if (!sessionId) return state;
      const previousActionId = reviewActionForRun(state.sessions[sessionId]?.activeRun)?.actionId;
      const nextState = applySessionInput({
        ...state,
        statusNotice: sessionId === state.focusedSessionId ? null : state.statusNotice,
        input: clearTextAreaTransientInputState({
          ...state.input,
          text: '',
          cursorOffset: 0,
          history: recordComposerHistoryEntry(state.input.history, action.message.text),
        }),
      }, sessionId, {
        type: 'user.accepted',
        requestId: action.requestId,
        kind: action.kind,
        text: action.message.text,
        message: {
          ...(action.message.id ? { id: action.message.id } : {}),
          ...(action.message.createdAt ? { createdAt: action.message.createdAt } : {}),
        },
      }, action.now);
      return removeReviewDraft(nextState, previousActionId);
    }
    case 'review.draft.record': {
      const owner = findSessionForRun(state, action.requestId);
      const reviewAction = reviewActionForRun(owner?.session.activeRun);
      if (!reviewAction || reviewAction.actionId !== action.actionId) return state;
      const draft = state.reviewDrafts[action.actionId]
        ?? { actionId: action.actionId, decisions: [] };
      if (draft.resolutionSent) return state;
      return {
        ...state,
        reviewDrafts: {
          ...state.reviewDrafts,
          [action.actionId]: {
            ...draft,
            decisions: [...draft.decisions, action.decision],
          },
        },
        input: clearTextAreaTransientInputState({
          ...state.input,
          text: '',
          cursorOffset: 0,
          history: resetComposerHistoryNavigation(state.input.history),
        }),
      };
    }
    case 'review.resolution.sent': {
      const owner = findSessionForRun(state, action.requestId);
      const reviewAction = reviewActionForRun(owner?.session.activeRun);
      if (!owner || !reviewAction || reviewAction.actionId !== action.actionId) return state;
      const draft = state.reviewDrafts[action.actionId]
        ?? { actionId: action.actionId, decisions: [] };
      if (draft.resolutionSent) return state;
      return {
        ...state,
        reviewDrafts: {
          ...state.reviewDrafts,
          [action.actionId]: {
            ...draft,
            decisions: action.decision
              ? [...draft.decisions, action.decision]
              : draft.decisions,
            resolutionSent: true,
          },
        },
        input: clearTextAreaTransientInputState({
          ...state.input,
          text: '',
          cursorOffset: 0,
          history: resetComposerHistoryNavigation(state.input.history),
        }),
      };
    }
    case 'run.interrupting': {
      const owner = findSessionForRun(state, action.requestId);
      if (!owner) return state;
      const actionId = reviewActionForRun(owner.session.activeRun)?.actionId;
      const nextState = applySessionInput(state, owner.sessionId, {
        type: 'run.interrupting',
        requestId: action.requestId,
      }, 0);
      const withoutDraft = removeReviewDraft(nextState, actionId);
      return withoutDraft;
    }
    case 'run.finish':
      return finishRun(
        state,
        action.requestId,
        action.statusNotice,
        action.messages,
      );
    case 'event.received':
      return reduceRuntimeEvent(state, action);
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
  return Boolean(
    reviewResolutionWasSent(state, activeRun)
    || (activeRun && activeRun.state !== 'waiting_review'),
  );
}

export function selectFocusedReviewResolutionSent(state: TuiState) {
  return reviewResolutionWasSent(state, selectFocusedActiveRun(state));
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
