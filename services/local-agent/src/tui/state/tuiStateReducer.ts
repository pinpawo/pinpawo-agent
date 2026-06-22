import {
  formatSubagentMessage,
  formatStudioProgressEvent,
  formatSystemNoticeEvent,
} from '../render/eventText';
import {
  navigateComposerHistory,
  recordComposerHistoryEntry,
  resetComposerHistoryNavigation,
} from '../input/composerHistory';
import { TUI_TEXT } from '../render/text';
import type {
  LocalAgentEvent,
  LocalAgentOperationEvent,
} from '../../events/localAgentEvent';
import {
  operationTimelineEntryFromEvent,
  timelineEntryFromMessageCell,
  timelineEntryIdFromOperationEvent,
  type AgentMessageEntry,
  type AgentOperationEntry,
  type AgentTimelineEntry,
} from '../timeline/agentTimeline';
import {
  TUI_CORE_TARGET_ACTIONS,
  type TuiCoreRunSnapshot,
  type TuiCoreSessionSnapshot,
} from '../contracts/tuiCoreContract';
import {
  agentTimelineEntriesFromSnapshot,
} from '../snapshot/tuiSessionSnapshot';
import { selectActiveOperationsFromTimeline } from '../timeline/agentTimelineSelectors';
import { MAX_TUI_ACTIVITY_ITEMS, MAX_TUI_NOTICE_ITEMS } from './tuiState';
import type {
  ActiveRunModel,
  MessageCellDraft,
  MessageCellMeta,
  MessageCellModel,
  RunId,
  SessionActivityModel,
  SessionNoticeModel,
  SessionId,
  SessionModel,
  TuiAction,
  TuiRunModel,
  TokenUsageModel,
  TuiState,
} from './tuiState';

function toMessageCell(draft: MessageCellDraft): MessageCellModel {
  return {
    id: draft.id,
    kind: draft.kind,
    text: draft.text,
    ...(draft.timestamp ? { timestamp: draft.timestamp } : {}),
  };
}

function appendMessageCells(
  session: SessionModel,
  drafts: MessageCellDraft[],
) {
  if (drafts.length === 0) return session;
  const cells = drafts.map(toMessageCell);
  const timeline = [...session.timeline];
  const notices = [...session.notices];
  let afterTimelineEntryId = timeline.at(-1)?.id;

  for (const cell of cells) {
    const entry = timelineEntryFromMessageCell(cell);
    if (entry) {
      timeline.push(entry);
      afterTimelineEntryId = entry.id;
      continue;
    }
    if (cell.kind === 'system') {
      notices.push({
        ...(afterTimelineEntryId ? { afterTimelineEntryId } : {}),
        id: cell.id,
        text: cell.text,
        ...(cell.timestamp ? { timestamp: cell.timestamp } : {}),
      });
    }
  }

  return {
    ...session,
    timeline,
    notices: trimNotices(notices),
  };
}

function trimNotices(notices: SessionNoticeModel[]) {
  return notices.length > MAX_TUI_NOTICE_ITEMS
    ? notices.slice(notices.length - MAX_TUI_NOTICE_ITEMS)
    : notices;
}

function trimActivities(activities: SessionActivityModel[]) {
  return activities.length > MAX_TUI_ACTIVITY_ITEMS
    ? activities.slice(activities.length - MAX_TUI_ACTIVITY_ITEMS)
    : activities;
}

function addTimelineEntryId<T extends ActiveRunModel>(activeRun: T, entryId: string): T {
  return activeRun.timelineEntryIds.includes(entryId)
    ? activeRun
    : {
        ...activeRun,
        timelineEntryIds: [...activeRun.timelineEntryIds, entryId],
      };
}

function appendOrUpdateTimelineEntry(
  timeline: AgentTimelineEntry[],
  entry: AgentTimelineEntry,
) {
  const index = timeline.findIndex((item) => item.id === entry.id);
  if (index < 0) {
    return [...timeline, entry];
  }
  return [
    ...timeline.slice(0, index),
    entry,
    ...timeline.slice(index + 1),
  ];
}

function countTimelineMessagesForRequest(
  timeline: AgentTimelineEntry[],
  requestId: string,
  role: AgentMessageEntry['role'],
) {
  return timeline.filter((entry) =>
    entry.type === 'message'
      && entry.requestId === requestId
      && entry.role === role).length;
}

function findStreamingAssistantIndex(timeline: AgentTimelineEntry[], requestId: string) {
  for (let index = timeline.length - 1; index >= 0; index -= 1) {
    const entry = timeline[index];
    if (entry.type === 'message' && entry.requestId === requestId && entry.role === 'assistant') {
      return entry.status === 'streaming' ? index : -1;
    }
  }
  return -1;
}

function findLatestAssistantTimelineText(session: SessionModel, requestId: string) {
  for (let index = session.timeline.length - 1; index >= 0; index -= 1) {
    const entry = session.timeline[index];
    if (entry.type === 'message' && entry.requestId === requestId && entry.role === 'assistant') {
      return entry.text.trim();
    }
  }
  return '';
}

function appendAssistantTimelineDelta(
  session: SessionModel,
  requestId: string,
  token: string,
): { session: SessionModel; entryId: string } {
  const streamingIndex = findStreamingAssistantIndex(session.timeline, requestId);
  if (streamingIndex >= 0) {
    const current = session.timeline[streamingIndex] as AgentMessageEntry;
    const entry: AgentMessageEntry = {
      ...current,
      text: current.text + token,
    };
    return {
      session: {
        ...session,
        timeline: [
          ...session.timeline.slice(0, streamingIndex),
          entry,
          ...session.timeline.slice(streamingIndex + 1),
        ],
      },
      entryId: entry.id,
    };
  }

  const entry: AgentMessageEntry = {
    id: `${requestId}:assistant:${countTimelineMessagesForRequest(session.timeline, requestId, 'assistant')}`,
    type: 'message',
    role: 'assistant',
    requestId,
    text: token,
    status: 'streaming',
  };
  return {
    session: {
      ...session,
      timeline: [...session.timeline, entry],
    },
    entryId: entry.id,
  };
}

function finalizeAssistantTimelineEntry(
  session: SessionModel,
  requestId: string,
  text: string,
): { session: SessionModel; entryId?: string } {
  if (!text) return { session };
  const streamingIndex = findStreamingAssistantIndex(session.timeline, requestId);
  if (streamingIndex >= 0) {
    const current = session.timeline[streamingIndex] as AgentMessageEntry;
    const entry: AgentMessageEntry = {
      ...current,
      text,
      status: 'completed',
    };
    return {
      session: {
        ...session,
        timeline: [
          ...session.timeline.slice(0, streamingIndex),
          entry,
          ...session.timeline.slice(streamingIndex + 1),
        ],
      },
      entryId: entry.id,
    };
  }

  const entry: AgentMessageEntry = {
    id: `${requestId}:assistant:${countTimelineMessagesForRequest(session.timeline, requestId, 'assistant')}`,
    type: 'message',
    role: 'assistant',
    requestId,
    text,
    status: 'completed',
  };
  return {
    session: {
      ...session,
      timeline: [...session.timeline, entry],
    },
    entryId: entry.id,
  };
}

function upsertOperationTimelineEntry(
  session: SessionModel,
  event: LocalAgentOperationEvent,
  now: number,
): { session: SessionModel; entry: AgentOperationEntry } {
  const id = timelineEntryIdFromOperationEvent(event);
  const previous = session.timeline.find((entry): entry is AgentOperationEntry =>
    entry.type === 'operation' && entry.id === id);
  const entry = operationTimelineEntryFromEvent(event, now, previous);
  return {
    session: {
      ...session,
      timeline: appendOrUpdateTimelineEntry(session.timeline, entry),
    },
    entry,
  };
}

function appendOrUpdateActivity(
  activities: SessionActivityModel[],
  activity: SessionActivityModel,
) {
  const index = activities.findIndex((item) => item.id === activity.id);
  if (index < 0) {
    return trimActivities([...activities, activity]);
  }
  return trimActivities([
    ...activities.slice(0, index),
    activity,
    ...activities.slice(index + 1),
  ]);
}

function readSubagentActivityText(session: SessionModel, activityId: string) {
  const activity = session.activities.find((item) => item.id === activityId);
  return activity?.type === 'subagent.message' ? activity.text : '';
}

function appendSubagentActivityDelta(
  session: SessionModel,
  requestId: string,
  token: string,
): { session: SessionModel; entryId?: string } {
  const id = `${requestId}:subagent-output`;
  const previous = session.activities.find((item) => item.id === id);
  const text = readSubagentActivityText(session, id) + token;
  const hasContent = Boolean(formatSubagentMessage(text));
  if (!hasContent) return { session };
  const activity: SessionActivityModel = {
    id,
    type: 'subagent.message',
    requestId,
    text,
    status: 'streaming',
    ...(previous?.timestamp ? { timestamp: previous.timestamp } : {}),
    ...(previous?.afterTimelineEntryId
      ? { afterTimelineEntryId: previous.afterTimelineEntryId }
      : session.timeline.at(-1)?.id
        ? { afterTimelineEntryId: session.timeline.at(-1)?.id }
        : {}),
  };
  return {
    session: {
      ...session,
      activities: appendOrUpdateActivity(session.activities, activity),
    },
    entryId: activity.id,
  };
}

function finalizeSubagentActivities(session: SessionModel, requestId: string) {
  return {
    ...session,
    activities: session.activities.map((activity) =>
      activity.requestId === requestId
        ? { ...activity, status: 'completed' as const }
        : activity),
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

function clearTextAreaTransientInputState(input: TuiState['input']): TuiState['input'] {
  return {
    ...input,
    selection: undefined,
    editHistory: undefined,
    preferredColumn: undefined,
  };
}

function updateRun(
  state: TuiState,
  requestId: string,
  updater: (run: TuiRunModel) => TuiRunModel,
) {
  const run = state.runs[requestId];
  if (!run) return state;
  return {
    ...state,
    runs: {
      ...state.runs,
      [requestId]: updater(run),
    },
  };
}

function removeRun(state: TuiState, requestId: string) {
  const run = state.runs[requestId];
  if (!run) return state;
  const { [requestId]: _removed, ...runs } = state.runs;
  const session = state.sessions[run.sessionId];
  return {
    ...state,
    runs,
    sessions: session
      ? {
          ...state.sessions,
          [run.sessionId]: {
            ...session,
            activeRunId: session.activeRunId === requestId ? null : session.activeRunId,
          },
        }
      : state.sessions,
  };
}

function removeSessionRuns(state: TuiState, sessionId: SessionId) {
  const runs = Object.fromEntries(
    Object.entries(state.runs).filter(([, run]) => run.sessionId !== sessionId),
  );
  return { ...state, runs };
}

function finishRun(
  state: TuiState,
  requestId: string,
  statusMessage: string,
  messages: MessageCellDraft[] = [],
  tokenUsage?: TokenUsageModel | null,
) {
  const run = state.runs[requestId];
  if (!run) return state;
  const sessionId = run.sessionId;
  const session = state.sessions[sessionId];
  if (!session) return state;
  const nextState = updateSession(state, sessionId, (sessionToUpdate) => {
    const finalizedSession = sessionToUpdate.activeRunId === requestId
      ? finalizeSubagentActivities(sessionToUpdate, requestId)
      : sessionToUpdate;
    return appendMessageCells({
      ...finalizedSession,
      activeRunId: sessionToUpdate.activeRunId === requestId ? null : sessionToUpdate.activeRunId,
    }, [
      ...messages,
    ]);
  });

  const stateWithRouteRemoved = {
    ...nextState,
    connection: {
      ...nextState.connection,
      message: statusMessage,
    },
  };
  const stateWithRunRemoved = removeRun(stateWithRouteRemoved, requestId);

  if (tokenUsage === undefined) {
    return stateWithRunRemoved;
  }

  if (tokenUsage === null) {
    const sessionToClear = stateWithRunRemoved.sessions[sessionId];
    if (!sessionToClear) {
      return stateWithRunRemoved;
    }
    return {
      ...stateWithRunRemoved,
      sessions: {
        ...stateWithRunRemoved.sessions,
        [sessionId]: {
          ...sessionToClear,
          tokenUsage: null,
        },
      },
    };
  }

  const runtimeContextWindow = stateWithRunRemoved.sessions[sessionId]?.runtime.contextWindow;
  const nextTokenUsage: TokenUsageModel = tokenUsage.contextWindow === undefined && runtimeContextWindow !== undefined
    ? { ...tokenUsage, contextWindow: runtimeContextWindow }
    : tokenUsage;
  const stateWithRuntimeUpdated = nextTokenUsage.contextWindow === undefined
    ? stateWithRunRemoved
    : updateSession(stateWithRunRemoved, sessionId, (sessionToUpdate) => ({
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

function activeRunToPendingUi(run: TuiRunModel | null) {
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

function clearPendingReview<T extends ActiveRunModel>(run: T): T {
  if (!run.pendingReview) return run;
  const { pendingReview, ...rest } = run;
  void pendingReview;
  return rest as T;
}

function activeRunToPendingApproval(run: TuiRunModel | null) {
  return run?.pendingReview
    ? {
        requestId: run.pendingReview.requestId,
        review: run.pendingReview.review,
        ...(run.pendingReview.petId ? { petId: run.pendingReview.petId } : {}),
      }
    : null;
}

function isTerminalSnapshotRun(run: TuiCoreRunSnapshot) {
  return run.phase === 'completed' || run.phase === 'failed' || run.phase === 'interrupted';
}

function activeRunPhaseFromSnapshot(run: TuiCoreRunSnapshot): ActiveRunModel['phase'] | null {
  if (isTerminalSnapshotRun(run)) return null;
  if (run.phase === 'using_tool' || run.phase === 'streaming' || run.phase === 'waiting_human' || run.phase === 'interrupting') {
    return run.phase;
  }
  return 'thinking';
}

function countSnapshotAssistantChars(snapshot: TuiCoreSessionSnapshot, requestId: string) {
  return snapshot.timeline.reduce((count, entry) => (
    entry.type === 'message' && entry.role === 'assistant' && entry.requestId === requestId
      ? count + entry.text.length
      : count
  ), 0);
}

function runFromSnapshot(
  snapshot: TuiCoreSessionSnapshot,
  run: TuiCoreRunSnapshot,
  existingRun: TuiRunModel | undefined,
): TuiRunModel | null {
  const phase = activeRunPhaseFromSnapshot(run);
  if (!phase) return null;
  return {
    requestId: run.requestId,
    sessionId: run.sessionId || snapshot.sessionId,
    kind: run.kind,
    phase,
    timelineEntryIds: run.timelineEntryIds,
    startedAt: run.startedAt ?? existingRun?.startedAt ?? 0,
    charCount: countSnapshotAssistantChars(snapshot, run.requestId),
    ...pendingReviewFromSnapshotRun(run, existingRun ?? null),
  };
}

function activeRunIdFromSnapshot(
  snapshot: TuiCoreSessionSnapshot,
  snapshotRuns: Record<RunId, TuiRunModel>,
) {
  const activeRunId = snapshot.activeRunId
    ?? snapshot.runs.find((run) => !isTerminalSnapshotRun(run))?.requestId;
  return activeRunId && snapshotRuns[activeRunId] ? activeRunId : null;
}

function pendingReviewFromSnapshotRun(
  run: TuiCoreRunSnapshot,
  existingRun: TuiRunModel | null,
): Pick<TuiRunModel, 'pendingReview'> | Record<string, never> {
  const pendingReview = run.pendingReview;
  if (pendingReview?.status !== 'waiting') return {};
  if (pendingReview.review) {
    return {
      pendingReview: {
        requestId: pendingReview.requestId,
        review: pendingReview.review,
        ...(pendingReview.petId ? { petId: pendingReview.petId } : {}),
      },
    };
  }
  return existingRun?.pendingReview
    ? { pendingReview: existingRun.pendingReview }
    : {};
}

function filterReconnectNotices(
  notices: SessionNoticeModel[],
  timeline: AgentTimelineEntry[],
) {
  const timelineIds = new Set(timeline.map((entry) => entry.id));
  return trimNotices(notices.filter((notice) =>
    !notice.afterTimelineEntryId || timelineIds.has(notice.afterTimelineEntryId)));
}

function applySessionSnapshot(
  state: TuiState,
  action: Extract<TuiAction, { type: typeof TUI_CORE_TARGET_ACTIONS.sessionSnapshotLoaded }>,
) {
  const snapshot = action.snapshot;
  const sessionId = snapshot.sessionId;
  const existingSession = state.sessions[sessionId];
  const focusedSession = state.focusedSessionId ? state.sessions[state.focusedSessionId] : undefined;
  const baseSession = existingSession ?? focusedSession;
  const timeline = agentTimelineEntriesFromSnapshot(snapshot.timeline);
  const sessionIdsToClear = new Set<SessionId>([sessionId]);
  if (action.source === 'resume' && state.focusedSessionId) {
    sessionIdsToClear.add(state.focusedSessionId);
  }
  const snapshotRunIds = new Set(snapshot.runs.map((run) => run.requestId));
  const preservedRuns = Object.fromEntries(
    Object.entries(state.runs).filter(([requestId, run]) =>
      !sessionIdsToClear.has(run.sessionId) && !snapshotRunIds.has(requestId)),
  );
  const snapshotRuns = Object.fromEntries(snapshot.runs.flatMap((run) => {
    const nextRun = runFromSnapshot(snapshot, run, state.runs[run.requestId]);
    return nextRun ? [[run.requestId, nextRun]] : [];
  }));
  const activeRunId = activeRunIdFromSnapshot(snapshot, snapshotRuns);
  const nextSession: SessionModel = {
    id: sessionId,
    kind: snapshot.kind,
    actor: baseSession?.actor ?? {
      label: TUI_TEXT.defaultPetName,
      summary: TUI_TEXT.defaultPetSummary,
    },
    runtime: {
      ...(baseSession?.runtime ?? {}),
      ...(snapshot.runtime ?? {}),
    },
    timeline,
    notices: action.source === 'reconnect'
      ? filterReconnectNotices(existingSession?.notices ?? [], timeline)
      : [],
    activities: [],
    activeRunId,
    tokenUsage: snapshot.tokenUsage
      ?? (action.source === 'reconnect' ? existingSession?.tokenUsage ?? null : null),
  };

  const nextSessions = {
    ...state.sessions,
    [sessionId]: nextSession,
  };
  for (const clearedSessionId of sessionIdsToClear) {
    if (clearedSessionId === sessionId) continue;
    const clearedSession = nextSessions[clearedSessionId];
    if (clearedSession?.activeRunId) {
      nextSessions[clearedSessionId] = {
        ...clearedSession,
        activeRunId: null,
      };
    }
  }

  return {
    ...state,
    focusedSessionId: sessionId,
    sessions: nextSessions,
    runs: {
      ...preservedRuns,
      ...snapshotRuns,
    },
  };
}

function messageDraft(
  kind: MessageCellModel['kind'],
  text: string,
  meta: MessageCellMeta | undefined,
  fallbackId: string,
): MessageCellDraft {
  return {
    id: meta?.id ?? fallbackId,
    kind,
    text,
    ...(meta?.timestamp ? { timestamp: meta.timestamp } : {}),
  };
}

export function tuiStateReducer(state: TuiState, action: TuiAction): TuiState {
  switch (action.type) {
    case TUI_CORE_TARGET_ACTIONS.sessionSnapshotLoaded:
      return applySessionSnapshot(state, action);

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

    case 'session.clear':
      {
        const sessionId = resolveSessionId(state, action.sessionId);
        const nextState = updateSession({
          ...state,
          ui: {
            ...state.ui,
            mode: 'chat',
            studioConversationId: null,
            externalEditorOpen: false,
          },
          connection: action.statusMessage
            ? { ...state.connection, message: action.statusMessage }
            : state.connection,
        }, sessionId, (session) => ({
          ...session,
          kind: 'chat',
          timeline: [],
          notices: [],
          activities: [],
          activeRunId: null,
          tokenUsage: null,
        }));
        return sessionId
          ? removeSessionRuns(nextState, sessionId)
          : nextState;
      }

    case 'ui.mode.set':
      return {
        ...state,
        ui: {
          ...state.ui,
          mode: action.mode,
          studioConversationId: action.mode === 'studio' ? action.studioConversationId ?? state.ui.studioConversationId : null,
        },
      };

    case 'ui.mode.reset':
      return {
        ...state,
        ui: {
          ...state.ui,
          mode: 'chat',
          studioConversationId: null,
        },
      };

    case 'ui.external_editor.set_open':
      return {
        ...state,
        ui: {
          ...state.ui,
          externalEditorOpen: action.open,
        },
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

    case 'input.history.navigate':
      {
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
      return updateSession(state, resolveSessionId(state, action.sessionId), (session) =>
        appendMessageCells(session, [action.cell]));

    case 'run.start': {
      const sessionId = resolveSessionId(state, action.sessionId);
      if (!sessionId) return state;
      const userDraft = messageDraft('user', action.userText, action.userCell, `${action.requestId}:user`);
      return updateSession({
        ...state,
        connection: {
          ...state.connection,
          message: action.statusMessage,
        },
        input: clearTextAreaTransientInputState({
          ...state.input,
          text: '',
          cursorOffset: 0,
          history: recordComposerHistoryEntry(state.input.history, action.userText),
        }),
        runs: {
          ...state.runs,
          [action.requestId]: {
            requestId: action.requestId,
            sessionId,
            kind: action.kind,
            phase: 'thinking',
            timelineEntryIds: [`message:${userDraft.id}`],
            startedAt: action.now,
            charCount: 0,
          },
        },
      }, sessionId, (session) => appendMessageCells({
        ...session,
        kind: action.kind,
        activeRunId: action.requestId,
        tokenUsage: null,
      }, [
        userDraft,
      ]));
    }

    case 'review.response.resume': {
      const existingRun = state.runs[action.requestId];
      const sessionId = existingRun?.sessionId ?? state.focusedSessionId;
      if (!sessionId) return state;
      const userDraft = messageDraft('user', action.message, action.userCell, `${action.requestId}:review-response`);
      const nextRun: TuiRunModel = existingRun
        ? addTimelineEntryId(clearPendingReview({
            ...existingRun,
            phase: 'thinking',
          }), `message:${userDraft.id}`)
        : {
            requestId: action.requestId,
            sessionId,
            kind: state.sessions[sessionId]?.kind ?? 'chat',
            phase: 'thinking',
            timelineEntryIds: [`message:${userDraft.id}`],
            startedAt: action.now,
            charCount: 0,
          };
      return updateSession({
        ...state,
        connection: {
          ...state.connection,
          message: action.statusMessage,
        },
        input: clearTextAreaTransientInputState({
          ...state.input,
          text: '',
          cursorOffset: 0,
          history: resetComposerHistoryNavigation(state.input.history),
        }),
        runs: {
          ...state.runs,
          [action.requestId]: nextRun,
        },
      }, sessionId, (session) => {
        return appendMessageCells({
          ...session,
          activeRunId: action.requestId,
        }, [
          userDraft,
        ]);
      });
    }

    case 'run.interrupting':
    case 'server.interrupting': {
      const run = state.runs[action.requestId];
      if (!run) return state;
      const stateWithRun = updateRun(state, action.requestId, (currentRun) => ({
        ...clearPendingReview(currentRun),
        sessionId: currentRun.sessionId,
        kind: currentRun.kind,
        phase: 'interrupting',
      }));
      return {
        ...stateWithRun,
        connection: {
          ...stateWithRun.connection,
          message: action.statusMessage,
        },
      };
    }

    case 'run.finish':
      return finishRun(state, action.requestId, action.statusMessage, action.messages);

    case 'event.received': {
      const event = action.event;
      const run = state.runs[event.requestId];
      if (!run) return state;
      const sessionId = run.sessionId;
      const session = state.sessions[sessionId];
      if (!session) {
        return state;
      }

      if (event.type === 'operation') {
        let operationEntryId: string | null = null;
        const stateWithTimeline = updateSession(state, sessionId, (currentSession) => {
          const { session: sessionWithTimeline, entry } = upsertOperationTimelineEntry(currentSession, event, action.now);
          operationEntryId = entry.id;
          return sessionWithTimeline;
        });
        return operationEntryId
          ? updateRun(stateWithTimeline, event.requestId, (currentRun) =>
              addTimelineEntryId({
                ...currentRun,
                phase: event.phase === 'started' || event.phase === 'updated'
                  ? 'using_tool'
                  : currentRun.phase,
              }, operationEntryId!))
          : stateWithTimeline;
      }

      if (event.type === 'message.delta') {
        const token = event.text;
        if (!token) return state;
        let assistantEntryId: string | null = null;
        const stateWithTimeline = updateSession(state, sessionId, (currentSession) => {
          const { session: sessionWithTimeline, entryId } = appendAssistantTimelineDelta(
            currentSession,
            event.requestId,
            token,
          );
          assistantEntryId = entryId;
          return sessionWithTimeline;
        });
        return assistantEntryId
          ? updateRun(stateWithTimeline, event.requestId, (currentRun) =>
              addTimelineEntryId({
                ...currentRun,
                phase: 'streaming',
                charCount: currentRun.charCount + token.length,
              }, assistantEntryId!))
          : stateWithTimeline;
      }

      if (event.type === 'subagent.message.delta') {
        const token = event.text;
        if (!token) return state;
        const stateWithActivity = updateSession(state, sessionId, (currentSession) => {
          const { session: sessionWithActivity } = appendSubagentActivityDelta(
            currentSession,
            event.requestId,
            token,
          );
          return sessionWithActivity;
        });
        return updateRun(stateWithActivity, event.requestId, (currentRun) => ({
          ...currentRun,
          phase: currentRun.phase === 'waiting_human' ? currentRun.phase : 'streaming',
          charCount: currentRun.charCount + token.length,
        }));
      }

      if (event.type === 'human_review.requested') {
        const petId = event.actor?.petId || undefined;
        const stateWithReview = {
          ...state,
          connection: {
            ...state.connection,
            message: TUI_TEXT.approvalWaiting(petId),
          },
        };
        return updateRun(stateWithReview, event.requestId, (currentRun) => ({
          ...currentRun,
          phase: 'waiting_human',
          charCount: 0,
          pendingReview: {
            requestId: event.requestId,
            review: event.review,
            ...(petId ? { petId } : {}),
          },
        }));
      }

      if (event.type === 'system.notice') {
        const notice = formatSystemNoticeEvent(event);
        return notice
          ? updateSession(state, sessionId, (currentSession) =>
              appendMessageCells(currentSession, [
                messageDraft('system', notice, action.messageCell, `${event.requestId}:notice`),
              ]))
          : state;
      }

      if (event.type === 'message.completed') {
        const reply = event.text.trim();
        const finalText = reply || findLatestAssistantTimelineText(session, event.requestId) || '...';
        const stateWithTimeline = updateSession(state, sessionId, (currentSession) => {
          const { session: sessionWithTimeline } = finalizeAssistantTimelineEntry(
            currentSession,
            event.requestId,
            finalText,
          );
          return sessionWithTimeline;
        });
        return finishRun(stateWithTimeline, event.requestId, TUI_TEXT.statusReady, [], event.usage ?? null);
      }

      if (event.type === 'studio.progress') {
        const line = formatStudioProgressEvent(event);
        return line
          ? updateSession(state, sessionId, (currentSession) =>
              appendMessageCells(currentSession, [
                messageDraft('system', line, action.messageCell, `${event.requestId}:studio-progress`),
              ]))
          : state;
      }

      if (event.type === 'error') {
        const message = event.message || 'internal error';
        return finishRun(state, event.requestId, TUI_TEXT.statusErrorRecovered, [
          messageDraft('system', TUI_TEXT.errorLine(message), action.messageCell, `${event.requestId}:event-error`),
        ]);
      }

      return state;
    }

    case 'server.interrupted':
      return finishRun(state, action.requestId, action.statusMessage, [
        messageDraft('assistant', TUI_TEXT.interrupted, action.messageCell, `${action.requestId}:interrupted`),
      ]);

    case 'server.studio_response': {
      const messages: MessageCellDraft[] = [
        action.reply.trim()
          ? messageDraft('assistant', action.reply.trim(), action.messageCell, `${action.requestId}:studio-response`)
          : messageDraft(
              'system',
              TUI_TEXT.studioEmptyTurn(action.outcome),
              action.messageCell,
              `${action.requestId}:studio-empty`,
            ),
      ];
      if (action.outcome === 'stopped' && action.reason) {
        messages.push(messageDraft(
          'system',
          TUI_TEXT.studioStoppedReason(action.reason),
          action.stoppedReasonCell,
          `${action.requestId}:studio-stopped`,
        ));
      }
      return finishRun(state, action.requestId, action.statusMessage, messages);
    }

    case 'server.studio_error':
      return finishRun(state, action.requestId, action.statusMessage, [
        messageDraft('system', TUI_TEXT.studioErrorLine(action.message || 'studio error'), action.messageCell, `${action.requestId}:studio-error`),
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

export function selectFocusedNotices(state: TuiState) {
  return selectFocusedSession(state)?.notices ?? [];
}

export function selectFocusedActivities(state: TuiState) {
  return selectFocusedSession(state)?.activities ?? [];
}

export function selectFocusedActiveRun(state: TuiState) {
  const session = selectFocusedSession(state);
  if (!session) return null;
  return session.activeRunId ? state.runs[session.activeRunId] ?? null : null;
}

export function selectFocusedBusy(state: TuiState) {
  const activeRun = selectFocusedActiveRun(state);
  return Boolean(activeRun && activeRun.phase !== 'waiting_human');
}

export function selectFocusedPendingUi(state: TuiState) {
  return activeRunToPendingUi(selectFocusedActiveRun(state));
}

export function selectFocusedActiveOperations(state: TuiState) {
  const session = selectFocusedSession(state);
  const activeRun = selectFocusedActiveRun(state);
  return session && activeRun
    ? selectActiveOperationsFromTimeline(session.timeline, activeRun.requestId)
    : [];
}

export function selectFocusedPendingApproval(state: TuiState) {
  return activeRunToPendingApproval(selectFocusedActiveRun(state));
}

export function selectReady(state: TuiState) {
  return state.connection.status === 'ready';
}
