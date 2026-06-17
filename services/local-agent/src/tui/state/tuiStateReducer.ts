import {
  formatSubagentMessage,
  formatOperationProgress,
  formatOperationResult,
  formatOperationStart,
  formatStudioProgressEvent,
  formatSystemNoticeEvent,
  getOperationKey,
} from '../render/eventText';
import {
  recordComposerHistoryEntry,
  resetComposerHistoryNavigation,
} from '../input/composerHistory';
import { TUI_TEXT } from '../render/text';
import type { LocalAgentEvent } from '../../events/localAgentEvent';
import type {
  ActiveOperationModel,
  ActiveRunModel,
  HistoryCellDraft,
  HistoryCellMeta,
  HistoryCellModel,
  SessionId,
  SessionModel,
  TuiAction,
  TokenUsageModel,
  TuiState,
} from './tuiState';
import { MAX_TUI_HISTORY_ITEMS } from './tuiState';

function trimHistory(history: HistoryCellModel[]) {
  return history.length > MAX_TUI_HISTORY_ITEMS
    ? history.slice(history.length - MAX_TUI_HISTORY_ITEMS)
    : history;
}

function toHistoryCell(draft: HistoryCellDraft): HistoryCellModel {
  return {
    id: draft.id,
    kind: draft.kind,
    text: draft.text,
    ...(draft.timestamp ? { timestamp: draft.timestamp } : {}),
  };
}

function appendHistory(session: SessionModel, drafts: HistoryCellDraft[]) {
  if (drafts.length === 0) return session;
  return {
    ...session,
    history: trimHistory([
      ...session.history,
      ...drafts.map(toHistoryCell),
    ]),
  };
}

function resolveSessionId(state: TuiState, sessionId?: SessionId) {
  return sessionId ?? state.focusedSessionId;
}

function updateSession(
  state: TuiState,
  sessionId: SessionId | null,
  updater: (session: SessionModel) => SessionModel,
) {
  if (!sessionId) return state;
  const session = state.sessions[sessionId];
  if (!session) return state;
  return {
    ...state,
    sessions: {
      ...state.sessions,
      [sessionId]: updater(session),
    },
  };
}

function removeRunRoute(state: TuiState, requestId: string) {
  const { [requestId]: _removed, ...runRoute } = state.runRoute;
  return runRoute;
}

function removeSessionRunRoutes(state: TuiState, sessionId: SessionId) {
  return Object.fromEntries(
    Object.entries(state.runRoute).filter(([, routedSessionId]) => routedSessionId !== sessionId),
  );
}

function finishRun(
  state: TuiState,
  requestId: string,
  statusMessage: string,
  history: HistoryCellDraft[] = [],
  tokenUsage?: TokenUsageModel | null,
) {
  const sessionId = state.runRoute[requestId];
  if (!sessionId) return state;
  const session = state.sessions[sessionId];
  const nextState = updateSession(state, sessionId, (sessionToUpdate) => {
    if (!sessionToUpdate.activeRun || sessionToUpdate.activeRun.requestId !== requestId) {
      return sessionToUpdate;
    }
    const subagentMessage = formatSubagentMessage(sessionToUpdate.activeRun.subagentDraft);
    return appendHistory({
      ...sessionToUpdate,
      activeRun: null,
    }, [
      ...(subagentMessage
        ? [historyDraft('system', subagentMessage, undefined, `${requestId}:subagent-output`)]
        : []),
      ...history,
    ]);
  });

  const stateWithRouteRemoved = {
    ...nextState,
    connection: {
      ...nextState.connection,
      message: statusMessage,
    },
    runRoute: removeRunRoute(nextState, requestId),
  };

  if (tokenUsage === undefined) {
    return stateWithRouteRemoved;
  }

  if (tokenUsage === null) {
    const sessionToClear = stateWithRouteRemoved.sessions[sessionId];
    if (!sessionToClear) {
      return stateWithRouteRemoved;
    }
    return {
      ...stateWithRouteRemoved,
      sessions: {
        ...stateWithRouteRemoved.sessions,
        [sessionId]: {
          ...sessionToClear,
          tokenUsage: null,
        },
      },
    };
  }

  const runtimeContextWindow = stateWithRouteRemoved.sessions[sessionId]?.runtime.contextWindow;
  const nextTokenUsage: TokenUsageModel = tokenUsage.contextWindow === undefined && runtimeContextWindow !== undefined
    ? { ...tokenUsage, contextWindow: runtimeContextWindow }
    : tokenUsage;
  const stateWithRuntimeUpdated = nextTokenUsage.contextWindow === undefined
    ? stateWithRouteRemoved
    : updateSession(stateWithRouteRemoved, sessionId, (sessionToUpdate) => ({
      ...sessionToUpdate,
      runtime: {
        ...sessionToUpdate.runtime,
        contextWindow: nextTokenUsage.contextWindow,
      },
    }));
  const runtimeUpdatedSession = stateWithRuntimeUpdated.sessions[sessionId];
  if (!runtimeUpdatedSession) {
    return stateWithRuntimeUpdated;
  }

  return {
      ...stateWithRuntimeUpdated,
      sessions: {
        ...stateWithRuntimeUpdated.sessions,
        [sessionId]: {
          ...runtimeUpdatedSession,
          tokenUsage: nextTokenUsage,
        },
      },
    };
}

function activeRunToPendingUi(run: ActiveRunModel | null) {
  if (!run || run.phase === 'waiting_human') return null;
  return {
    startedAt: run.startedAt,
    phase: run.phase === 'interrupting'
      ? 'interrupting' as const
      : run.phase === 'streaming'
        ? 'replying' as const
        : 'thinking' as const,
    charCount: run.charCount,
  };
}

function activeRunToActiveOperations(run: ActiveRunModel | null) {
  return run?.activeOperations.map((operation) => ({
    name: operation.key,
    label: operation.title,
    detail: operation.detail,
    startedAt: operation.startedAt,
  })) ?? [];
}

function clearPendingReview(run: ActiveRunModel): ActiveRunModel {
  if (!run.pendingReview) return run;
  const { pendingReview, ...rest } = run;
  void pendingReview;
  return rest;
}

function activeRunToPendingApproval(run: ActiveRunModel | null) {
  return run?.pendingReview
    ? {
        requestId: run.pendingReview.requestId,
        review: run.pendingReview.review,
        ...(run.pendingReview.petId ? { petId: run.pendingReview.petId } : {}),
      }
    : null;
}

function updateOperation(
  activeRun: ActiveRunModel,
  operation: ActiveOperationModel,
) {
  return [
    ...activeRun.activeOperations.filter((item) => item.key !== operation.key),
    operation,
  ];
}

function historyDraft(
  kind: HistoryCellModel['kind'],
  text: string,
  meta: HistoryCellMeta | undefined,
  fallbackId: string,
): HistoryCellDraft {
  return {
    id: meta?.id ?? fallbackId,
    kind,
    text,
    ...(meta?.timestamp ? { timestamp: meta.timestamp } : {}),
  };
}

export function tuiStateReducer(state: TuiState, action: TuiAction): TuiState {
  switch (action.type) {
    case 'connection.set':
      return {
        ...state,
        connection: {
          status: action.status,
          message: action.message,
        },
      };

    case 'session.set_actor':
      return updateSession(state, resolveSessionId(state, action.sessionId), (session) => ({
        ...session,
        actor: action.actor,
      }));

    case 'session.set_runtime':
      return updateSession(state, resolveSessionId(state, action.sessionId), (session) => ({
        ...session,
        runtime: {
          ...session.runtime,
          ...action.runtime,
        },
      }));

    case 'session.set_kind':
      return updateSession(state, resolveSessionId(state, action.sessionId), (session) => ({
        ...session,
        kind: action.kind,
      }));

    case 'session.replace_history':
      return updateSession(state, resolveSessionId(state, action.sessionId), (session) => ({
        ...session,
        history: trimHistory(action.history),
        tokenUsage: null,
      }));

    case 'session.clear':
      {
        const sessionId = resolveSessionId(state, action.sessionId);
        const nextState = updateSession({
          ...state,
          connection: action.statusMessage
            ? { ...state.connection, message: action.statusMessage }
            : state.connection,
        }, sessionId, (session) => ({
          ...session,
          history: [],
          activeRun: null,
          tokenUsage: null,
        }));
        return sessionId
          ? { ...nextState, runRoute: removeSessionRunRoutes(nextState, sessionId) }
          : nextState;
      }

    case 'input.set':
      return {
        ...state,
        input: {
          ...state.input,
          text: action.value,
          cursorOffset: action.cursorOffset ?? action.value.length,
          history: resetComposerHistoryNavigation(state.input.history),
        },
      };

    case 'input.apply':
      return {
        ...state,
        input: {
          ...state.input,
          text: action.value.text,
          cursorOffset: action.value.cursorOffset,
          history: resetComposerHistoryNavigation(state.input.history),
        },
      };

    case 'history.append':
      return updateSession(state, resolveSessionId(state, action.sessionId), (session) =>
        appendHistory(session, [action.cell]));

    case 'run.start': {
      const sessionId = resolveSessionId(state, action.sessionId);
      if (!sessionId) return state;
      return updateSession({
        ...state,
        connection: {
          ...state.connection,
          message: action.statusMessage,
        },
        input: {
          ...state.input,
          text: '',
          cursorOffset: 0,
          history: recordComposerHistoryEntry(state.input.history, action.userText),
        },
        runRoute: {
          ...state.runRoute,
          [action.requestId]: sessionId,
        },
      }, sessionId, (session) => appendHistory({
        ...session,
        kind: action.kind,
        activeRun: {
          requestId: action.requestId,
          phase: 'thinking',
          assistantDraft: '',
          subagentDraft: '',
          activeOperations: [],
          startedAt: action.now,
          charCount: 0,
        },
        tokenUsage: null,
      }, [
        historyDraft('user', action.userText, action.userCell, `${action.requestId}:user`),
      ]));
    }

    case 'review.response.resume': {
      // Server resumes the same LangGraph run from its checkpoint, so we
      // preserve the existing activeRun (and its startedAt) — only the phase
      // flips from waiting_human back to thinking, and the pending approval
      // is cleared. If for some reason there is no existing activeRun (e.g.
      // a stale review handed out before this controller loaded), fall back
      // to creating one keyed by the same requestId.
      const sessionId = state.runRoute[action.requestId] ?? state.focusedSessionId;
      if (!sessionId) return state;
      return updateSession({
        ...state,
        connection: {
          ...state.connection,
          message: action.statusMessage,
        },
        input: {
          ...state.input,
          text: '',
          cursorOffset: 0,
          history: resetComposerHistoryNavigation(state.input.history),
        },
        runRoute: {
          ...state.runRoute,
          [action.requestId]: sessionId,
        },
      }, sessionId, (session) => appendHistory({
        ...session,
        activeRun: session.activeRun?.requestId === action.requestId
          ? clearPendingReview({
              ...session.activeRun,
              phase: 'thinking',
              assistantDraft: '',
            })
          : {
              requestId: action.requestId,
              phase: 'thinking',
              assistantDraft: '',
              subagentDraft: '',
              activeOperations: [],
              startedAt: action.now,
              charCount: 0,
            },
      }, [
        historyDraft('user', action.message, action.userCell, `${action.requestId}:review-response`),
      ]));
    }

    case 'run.interrupting':
    case 'server.interrupting': {
      const sessionId = state.runRoute[action.requestId];
      if (!sessionId) return state;
      return updateSession({
        ...state,
        connection: {
          ...state.connection,
          message: action.statusMessage,
        },
      }, sessionId, (session) => session.activeRun?.requestId === action.requestId
        ? {
            ...session,
            activeRun: {
              ...clearPendingReview(session.activeRun),
              phase: 'interrupting',
            },
          }
        : session);
    }

    case 'run.finish':
      return finishRun(state, action.requestId, action.statusMessage, action.history);

    case 'event.received': {
      const event = action.event;
      const sessionId = state.runRoute[event.requestId];
      if (!sessionId) return state;
      const session = state.sessions[sessionId];
      const activeRun = session?.activeRun;
      if (!session || !activeRun || activeRun.requestId !== event.requestId) {
        return state;
      }

      if (event.type === 'operation') {
        const operationKey = getOperationKey(event);
        if (event.phase === 'started') {
          const summary = formatOperationStart(event);
          return updateSession(state, sessionId, (currentSession) => ({
            ...currentSession,
            activeRun: currentSession.activeRun?.requestId === event.requestId
              ? {
                  ...currentSession.activeRun,
                  phase: 'using_tool',
                  activeOperations: updateOperation(currentSession.activeRun, {
                    key: operationKey,
                    kind: event.operation.kind,
                    title: summary.label,
                    detail: summary.detail,
                    startedAt: action.now,
                  }),
                }
              : currentSession.activeRun,
          }));
        }
        if (event.phase === 'updated') {
          const progress = formatOperationProgress(event);
          return updateSession(state, sessionId, (currentSession) => ({
            ...currentSession,
            activeRun: currentSession.activeRun?.requestId === event.requestId
              ? {
                  ...currentSession.activeRun,
                  phase: 'using_tool',
                  activeOperations: currentSession.activeRun.activeOperations.map((operation) => (
                    operation.key === operationKey
                      ? { ...operation, detail: progress || operation.detail }
                      : operation
                  )),
                }
              : currentSession.activeRun,
          }));
        }
        return updateSession(state, sessionId, (currentSession) => appendHistory({
          ...currentSession,
          activeRun: currentSession.activeRun?.requestId === event.requestId
            ? {
                ...currentSession.activeRun,
                activeOperations: currentSession.activeRun.activeOperations
                  .filter((operation) => operation.key !== operationKey),
              }
            : currentSession.activeRun,
        }, [
          historyDraft('system', formatOperationResult(event), action.historyCell, `${event.requestId}:operation:${operationKey}`),
        ]));
      }

      if (event.type === 'message.delta') {
        const token = event.text;
        if (!token) return state;
        return updateSession(state, sessionId, (currentSession) => ({
          ...currentSession,
          activeRun: currentSession.activeRun?.requestId === event.requestId
            ? {
                ...currentSession.activeRun,
                phase: 'streaming',
                assistantDraft: currentSession.activeRun.assistantDraft + token,
                charCount: currentSession.activeRun.charCount + token.length,
              }
            : currentSession.activeRun,
        }));
      }

      if (event.type === 'subagent.message.delta') {
        const token = event.text;
        if (!token) return state;
        return updateSession(state, sessionId, (currentSession) => ({
          ...currentSession,
          activeRun: currentSession.activeRun?.requestId === event.requestId
            ? {
                ...currentSession.activeRun,
                phase: currentSession.activeRun.phase === 'waiting_human'
                  ? currentSession.activeRun.phase
                  : 'streaming',
                subagentDraft: currentSession.activeRun.subagentDraft + token,
                charCount: currentSession.activeRun.charCount + token.length,
              }
            : currentSession.activeRun,
        }));
      }

      if (event.type === 'human_review.requested') {
        const petId = event.actor?.petId || undefined;
        return updateSession({
          ...state,
          connection: {
            ...state.connection,
            message: TUI_TEXT.approvalWaiting(petId),
          },
        }, sessionId, (currentSession) => ({
          ...currentSession,
          activeRun: currentSession.activeRun?.requestId === event.requestId
            ? {
                ...currentSession.activeRun,
                phase: 'waiting_human',
                assistantDraft: '',
                activeOperations: [],
                charCount: 0,
                pendingReview: {
                  requestId: event.requestId,
                  review: event.review,
                  ...(petId ? { petId } : {}),
                },
              }
            : currentSession.activeRun,
        }));
      }

      if (event.type === 'system.notice') {
        const notice = formatSystemNoticeEvent(event);
        return notice
          ? updateSession(state, sessionId, (currentSession) =>
              appendHistory(currentSession, [
                historyDraft('system', notice, action.historyCell, `${event.requestId}:notice`),
              ]))
          : state;
      }

      if (event.type === 'message.completed') {
        const reply = event.text.trim();
        const finalText = reply || activeRun.assistantDraft.trim() || '...';
        return finishRun(state, event.requestId, TUI_TEXT.statusReady, finalText
          ? [historyDraft('assistant', finalText, action.historyCell, `${event.requestId}:assistant`)]
          : [],
          event.usage ?? null,
        );
      }

      if (event.type === 'studio.progress') {
        const line = formatStudioProgressEvent(event);
        return line
          ? updateSession(state, sessionId, (currentSession) =>
              appendHistory(currentSession, [
                historyDraft('system', line, action.historyCell, `${event.requestId}:studio-progress`),
              ]))
          : state;
      }

      if (event.type === 'error') {
        const message = event.message || 'internal error';
        return finishRun(state, event.requestId, TUI_TEXT.statusErrorRecovered, [
          historyDraft('system', TUI_TEXT.errorLine(message), action.historyCell, `${event.requestId}:event-error`),
        ]);
      }

      return state;
    }

    case 'server.interrupted':
      return finishRun(state, action.requestId, action.statusMessage, [
        historyDraft('assistant', TUI_TEXT.interrupted, action.historyCell, `${action.requestId}:interrupted`),
      ]);

    case 'server.studio_response': {
      const history: HistoryCellDraft[] = [
        action.reply.trim()
          ? historyDraft('assistant', action.reply.trim(), action.historyCell, `${action.requestId}:studio-response`)
          : historyDraft(
              'system',
              TUI_TEXT.studioEmptyTurn(action.outcome),
              action.historyCell,
              `${action.requestId}:studio-empty`,
            ),
      ];
      if (action.outcome === 'stopped' && action.reason) {
        history.push(historyDraft(
          'system',
          TUI_TEXT.studioStoppedReason(action.reason),
          action.stoppedReasonCell,
          `${action.requestId}:studio-stopped`,
        ));
      }
      return finishRun(state, action.requestId, action.statusMessage, history);
    }

    case 'server.studio_error':
      return finishRun(state, action.requestId, action.statusMessage, [
        historyDraft('system', TUI_TEXT.studioErrorLine(action.message || 'studio error'), action.historyCell, `${action.requestId}:studio-error`),
      ]);

    default:
      return state;
  }
}

export function selectFocusedSession(state: TuiState) {
  return state.focusedSessionId ? state.sessions[state.focusedSessionId] ?? null : null;
}

export function selectFocusedHistory(state: TuiState) {
  return selectFocusedSession(state)?.history ?? [];
}

export function selectFocusedActiveRun(state: TuiState) {
  return selectFocusedSession(state)?.activeRun ?? null;
}

export function selectFocusedBusy(state: TuiState) {
  const activeRun = selectFocusedActiveRun(state);
  return Boolean(activeRun && activeRun.phase !== 'waiting_human');
}

export function selectFocusedPendingUi(state: TuiState) {
  return activeRunToPendingUi(selectFocusedActiveRun(state));
}

export function selectFocusedActiveOperations(state: TuiState) {
  return activeRunToActiveOperations(selectFocusedActiveRun(state));
}

export function selectFocusedSubagentDraft(state: TuiState) {
  return selectFocusedActiveRun(state)?.subagentDraft ?? '';
}

export function selectFocusedPendingApproval(state: TuiState) {
  return activeRunToPendingApproval(selectFocusedActiveRun(state));
}

export function selectReady(state: TuiState) {
  return state.connection.status === 'ready';
}
