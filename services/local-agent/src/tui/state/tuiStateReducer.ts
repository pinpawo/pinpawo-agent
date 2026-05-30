import {
  formatOperationProgress,
  formatOperationResult,
  formatOperationStart,
  formatStudioProgressEvent,
  getOperationKey,
} from '../render/eventText';
import type {
  ActiveOperationModel,
  ActiveRunModel,
  HistoryCellDraft,
  HistoryCellMeta,
  HistoryCellModel,
  SessionId,
  SessionModel,
  TuiAction,
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
) {
  const sessionId = state.runRoute[requestId];
  if (!sessionId) return state;
  const nextState = updateSession(state, sessionId, (session) => {
    if (!session.activeRun || session.activeRun.requestId !== requestId) {
      return session;
    }
    return appendHistory({
      ...session,
      activeRun: null,
    }, history);
  });
  return {
    ...nextState,
    connection: {
      ...nextState.connection,
      message: statusMessage,
    },
    runRoute: removeRunRoute(nextState, requestId),
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

function activeRunToActiveTools(run: ActiveRunModel | null) {
  return run?.activeOperations.map((operation) => ({
    name: operation.key,
    label: operation.title,
    detail: operation.detail,
    startedAt: operation.startedAt,
  })) ?? [];
}

function activeRunToPendingInterrupt(run: ActiveRunModel | null) {
  return run?.pendingReview
    ? {
        kind: run.pendingReview.kind,
        requestId: run.pendingReview.requestId,
        prompt: run.pendingReview.prompt,
        payload: run.pendingReview.payload,
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

    case 'session.set_kind':
      return updateSession(state, resolveSessionId(state, action.sessionId), (session) => ({
        ...session,
        kind: action.kind,
      }));

    case 'session.replace_history':
      return updateSession(state, resolveSessionId(state, action.sessionId), (session) => ({
        ...session,
        history: trimHistory(action.history),
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
          value: action.value,
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
          value: '',
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
          activeOperations: [],
          startedAt: action.now,
          charCount: 0,
        },
      }, [
        historyDraft('user', action.userText, action.userCell, `${action.requestId}:user`),
      ]));
    }

    case 'review.response.start': {
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
          value: '',
        },
        runRoute: {
          ...state.runRoute,
          [action.requestId]: sessionId,
        },
      }, sessionId, (session) => appendHistory({
        ...session,
        activeRun: {
          requestId: action.requestId,
          phase: 'thinking',
          assistantDraft: '',
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
              ...session.activeRun,
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

      if (event.type === 'human_review.requested') {
        const prompt = event.prompt.trim() || '当前流程需要你的确认，请直接回复继续或说明下一步。';
        const kind = typeof event.payload.kind === 'string' ? event.payload.kind : 'interrupt';
        const petId = event.actor?.petId || undefined;
        return updateSession({
          ...state,
          connection: {
            ...state.connection,
            message: petId ? `等待你的决定(${petId})` : '等待你的决定',
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
                  kind,
                  prompt,
                  payload: event.payload,
                  ...(petId ? { petId } : {}),
                },
              }
            : currentSession.activeRun,
        }));
      }

      if (event.type === 'system.notice') {
        const notice = event.message.trim();
        return notice
          ? updateSession(state, sessionId, (currentSession) =>
              appendHistory(currentSession, [
                historyDraft('system', notice, action.historyCell, `${event.requestId}:notice`),
              ]))
          : state;
      }

      if (event.type === 'message.completed') {
        const reply = event.text.trim();
        const finalText = activeRun.assistantDraft.trim() || reply || '...';
        return finishRun(state, event.requestId, '就绪', finalText
          ? [historyDraft('assistant', finalText, action.historyCell, `${event.requestId}:assistant`)]
          : []);
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
        return finishRun(state, event.requestId, '出错，已恢复输入', [
          historyDraft('system', `出错: ${message}`, action.historyCell, `${event.requestId}:event-error`),
        ]);
      }

      return state;
    }

    case 'server.interrupted':
      return finishRun(state, action.requestId, action.statusMessage, [
        historyDraft('assistant', '[interrupted]', action.historyCell, `${action.requestId}:interrupted`),
      ]);

    case 'server.studio_response': {
      const history: HistoryCellDraft[] = [
        action.reply.trim()
          ? historyDraft('assistant', action.reply.trim(), action.historyCell, `${action.requestId}:studio-response`)
          : historyDraft(
              'system',
              `[studio] turn ${action.outcome} (无最终输出)`,
              action.historyCell,
              `${action.requestId}:studio-empty`,
            ),
      ];
      if (action.outcome === 'stopped' && action.reason) {
        history.push(historyDraft(
          'system',
          `[studio] stopped: ${action.reason}`,
          action.stoppedReasonCell,
          `${action.requestId}:studio-stopped`,
        ));
      }
      return finishRun(state, action.requestId, action.statusMessage, history);
    }

    case 'server.studio_error':
      return finishRun(state, action.requestId, action.statusMessage, [
        historyDraft('system', `[studio 出错] ${action.message || 'studio error'}`, action.historyCell, `${action.requestId}:studio-error`),
      ]);

    case 'server.error':
      return finishRun(state, action.requestId, action.statusMessage, [
        historyDraft('system', `出错: ${action.message || 'internal error'}`, action.historyCell, `${action.requestId}:server-error`),
      ]);

    case 'review.dismiss': {
      return finishRun(state, action.requestId, action.statusMessage);
    }

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

export function selectFocusedActiveTools(state: TuiState) {
  return activeRunToActiveTools(selectFocusedActiveRun(state));
}

export function selectFocusedPendingInterrupt(state: TuiState) {
  return activeRunToPendingInterrupt(selectFocusedActiveRun(state));
}

export function selectReady(state: TuiState) {
  return state.connection.status === 'ready';
}
