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
import { MAX_REASONABLE_ELAPSED_MS } from '../render/terminalText';
import {
  agentTimelineEntriesFromSnapshot,
} from '../snapshot/tuiSessionSnapshot';
import { selectActiveOperationsFromTimeline } from '../timeline/agentTimelineSelectors';
import type {
  ActiveRunModel,
  MessageCellDraft,
  MessageCellMeta,
  MessageCellModel,
  RunId,
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
    ...(draft.requestId ? { requestId: draft.requestId } : {}),
    ...(draft.timestamp ? { timestamp: draft.timestamp } : {}),
  };
}

function appendMessageCells(
  session: SessionModel,
  drafts: MessageCellDraft[],
) {
  if (drafts.length === 0) return session;
  const cells = drafts.map(toMessageCell);
  return {
    ...session,
    timeline: [
      ...session.timeline,
      ...cells.map(timelineEntryFromMessageCell),
    ],
  };
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

function findSessionIdForTimelineRequest(state: TuiState, requestId: string): SessionId | null {
  for (const [sessionId, session] of Object.entries(state.sessions)) {
    if (session.timeline.some((entry) => entry.requestId === requestId)) {
      return sessionId;
    }
  }
  return null;
}

function hasLocalInterruptReleaseNotice(session: SessionModel, requestId: string) {
  return session.timeline.some((entry) =>
    entry.type === 'message'
      && entry.role === 'system'
      && entry.id === `message:${requestId}:interrupt-local-release`);
}

type TimelineEventOwner = {
  requestId: RunId;
  sessionId: SessionId;
  run: TuiRunModel | null;
  recoveredFromTimeline: boolean;
};

function resolveTimelineEventOwner(
  state: TuiState,
  requestId: RunId,
  options: { allowTimelineFallback?: boolean } = {},
): TimelineEventOwner | null {
  const run = state.runs[requestId];
  if (run) {
    return {
      requestId,
      sessionId: run.sessionId,
      run,
      recoveredFromTimeline: false,
    };
  }

  if (!options.allowTimelineFallback) return null;
  const sessionId = findSessionIdForTimelineRequest(state, requestId);
  return sessionId
    ? {
        requestId,
        sessionId,
        run: null,
        recoveredFromTimeline: true,
      }
    : null;
}

function appendAssistantTimelineDelta(
  session: SessionModel,
  requestId: string,
  token: string,
  timestamp?: string,
): { session: SessionModel; entryId: string } {
  const streamingIndex = findStreamingAssistantIndex(session.timeline, requestId);
  if (streamingIndex >= 0) {
    const current = session.timeline[streamingIndex] as AgentMessageEntry;
    const entry: AgentMessageEntry = {
      ...current,
      text: current.text + token,
      ...(timestamp ? { updatedAt: timestamp } : {}),
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
    ...(timestamp ? { createdAt: timestamp } : {}),
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
  timestamp?: string,
): { session: SessionModel; entryId?: string } {
  if (!text) return { session };
  const streamingIndex = findStreamingAssistantIndex(session.timeline, requestId);
  if (streamingIndex >= 0) {
    const current = session.timeline[streamingIndex] as AgentMessageEntry;
    const entry: AgentMessageEntry = {
      ...current,
      text,
      status: 'completed',
      ...(timestamp ? { updatedAt: timestamp } : {}),
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
    ...(timestamp ? { createdAt: timestamp } : {}),
  };
  return {
    session: {
      ...session,
      timeline: [...session.timeline, entry],
    },
    entryId: entry.id,
  };
}

function settleStreamingAssistantTimelineEntry(
  session: SessionModel,
  requestId: string,
): SessionModel {
  const streamingIndex = findStreamingAssistantIndex(session.timeline, requestId);
  if (streamingIndex < 0) return session;
  const current = session.timeline[streamingIndex] as AgentMessageEntry;
  const entry: AgentMessageEntry = {
    ...current,
    status: 'completed',
  };
  return {
    ...session,
    timeline: [
      ...session.timeline.slice(0, streamingIndex),
      entry,
      ...session.timeline.slice(streamingIndex + 1),
    ],
  };
}

function upsertOperationTimelineEntry(
  session: SessionModel,
  event: LocalAgentOperationEvent,
  now: number,
): { session: SessionModel; entry: AgentOperationEntry } {
  const sessionWithSettledAssistant = event.phase === 'started'
    ? settleStreamingAssistantTimelineEntry(session, event.requestId)
    : session;
  const id = timelineEntryIdFromOperationEvent(event);
  const previous = sessionWithSettledAssistant.timeline.find((entry): entry is AgentOperationEntry =>
    entry.type === 'operation' && entry.id === id);
  const entry = operationTimelineEntryFromEvent(event, now, previous);
  return {
    session: {
      ...sessionWithSettledAssistant,
      timeline: appendOrUpdateTimelineEntry(sessionWithSettledAssistant.timeline, entry),
    },
    entry,
  };
}

function readSubagentMessageText(session: SessionModel, entryId: string) {
  const message = session.timeline.find((entry) =>
    entry.type === 'message'
      && entry.role === 'subagent'
      && entry.id === entryId);
  return message?.type === 'message' ? message.text : '';
}

function appendSubagentMessageDelta(
  session: SessionModel,
  requestId: string,
  token: string,
): { session: SessionModel; entryId?: string } {
  const id = `${requestId}:subagent-output`;
  const previous = session.timeline.find((entry): entry is AgentMessageEntry =>
    entry.type === 'message'
      && entry.role === 'subagent'
      && entry.id === id);
  const text = readSubagentMessageText(session, id) + token;
  const hasContent = Boolean(formatSubagentMessage(text));
  if (!hasContent) return { session };
  const message: AgentMessageEntry = {
    id,
    type: 'message',
    role: 'subagent',
    requestId,
    text,
    status: 'streaming',
    ...(previous?.createdAt ? { createdAt: previous.createdAt } : {}),
    ...(previous?.updatedAt ? { updatedAt: previous.updatedAt } : {}),
  };
  return {
    session: {
      ...session,
      timeline: appendOrUpdateTimelineEntry(session.timeline, message),
    },
    entryId: message.id,
  };
}

function finalizeSubagentMessages(session: SessionModel, requestId: string) {
  return {
    ...session,
    timeline: session.timeline.map((entry) =>
      entry.type === 'message'
        && entry.role === 'subagent'
        && entry.requestId === requestId
        ? { ...entry, status: 'completed' as const }
        : entry),
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

function updateExistingRun(
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
      ? finalizeSubagentMessages(sessionToUpdate, requestId)
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
  const shouldInferContextWindow = tokenUsage.scope !== 'run'
    && tokenUsage.contextWindow === undefined
    && runtimeContextWindow !== undefined;
  const nextTokenUsage: TokenUsageModel = shouldInferContextWindow
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

function applyRecoveredTerminalUsage(
  state: TuiState,
  sessionId: SessionId,
  tokenUsage: TokenUsageModel | undefined,
) {
  if (!tokenUsage) return state;
  const session = state.sessions[sessionId];
  if (!session) return state;
  const shouldInferContextWindow = tokenUsage.scope !== 'run'
    && tokenUsage.contextWindow === undefined
    && session.runtime.contextWindow !== undefined;
  const nextTokenUsage = shouldInferContextWindow
    ? { ...tokenUsage, contextWindow: session.runtime.contextWindow }
    : tokenUsage;
  return {
    ...state,
    sessions: {
      ...state.sessions,
      [sessionId]: {
        ...session,
        tokenUsage: nextTokenUsage,
        runtime: nextTokenUsage.contextWindow === undefined
          ? session.runtime
          : {
              ...session.runtime,
              contextWindow: nextTokenUsage.contextWindow,
            },
      },
    },
  };
}

function finishRecoveredTimelineRequest(
  state: TuiState,
  sessionId: SessionId,
  tokenUsage?: TokenUsageModel,
) {
  return applyRecoveredTerminalUsage({
    ...state,
    connection: {
      ...state.connection,
      message: TUI_TEXT.statusReady,
    },
  }, sessionId, tokenUsage);
}

function applyAssistantMessageDeltaEvent(
  state: TuiState,
  event: Extract<LocalAgentEvent, { type: 'message.delta' }>,
  messageCell?: MessageCellMeta,
) {
  const token = event.text;
  if (!token) return state;
  const owner = resolveTimelineEventOwner(state, event.requestId);
  if (!owner) return state;
  let assistantEntryId: string | null = null;
  const stateWithTimeline = updateSession(state, owner.sessionId, (currentSession) => {
    const { session: sessionWithTimeline, entryId } = appendAssistantTimelineDelta(
      currentSession,
      event.requestId,
      token,
      messageCell?.timestamp,
    );
    assistantEntryId = entryId;
    return sessionWithTimeline;
  });
  return assistantEntryId && owner.run
    ? {
        ...stateWithTimeline,
        runs: {
          ...stateWithTimeline.runs,
          [event.requestId]: addTimelineEntryId({
            ...owner.run,
            phase: 'streaming',
            charCount: owner.run.charCount + token.length,
          }, assistantEntryId),
        },
      }
    : stateWithTimeline;
}

function applyAssistantMessageCompletedEvent(
  state: TuiState,
  event: Extract<LocalAgentEvent, { type: 'message.completed' }>,
  messageCell?: MessageCellMeta,
) {
  const owner = resolveTimelineEventOwner(state, event.requestId, { allowTimelineFallback: true });
  if (!owner) return state;
  const session = state.sessions[owner.sessionId];
  if (!session) return state;
  if (owner.recoveredFromTimeline && hasLocalInterruptReleaseNotice(session, event.requestId)) return state;
  const reply = event.text.trim();
  const finalText = reply || findLatestAssistantTimelineText(session, event.requestId) || '...';
  const stateWithTimeline = updateSession(state, owner.sessionId, (currentSession) => {
    const { session: sessionWithTimeline } = finalizeAssistantTimelineEntry(
      currentSession,
      event.requestId,
      finalText,
      messageCell?.timestamp,
    );
    return sessionWithTimeline;
  });
  return owner.run
    ? finishRun(stateWithTimeline, event.requestId, TUI_TEXT.statusReady, [], event.usage ?? null)
    : finishRecoveredTimelineRequest(stateWithTimeline, owner.sessionId, event.usage);
}

type RunEventContext = {
  run: TuiRunModel;
  sessionId: SessionId;
};

function resolveRunEventContext(
  state: TuiState,
  event: Pick<LocalAgentEvent, 'requestId'>,
): RunEventContext | null {
  const run = state.runs[event.requestId];
  if (!run) return null;
  const sessionId = run.sessionId;
  return state.sessions[sessionId] ? { run, sessionId } : null;
}

function applyOperationEvent(
  state: TuiState,
  event: Extract<LocalAgentEvent, { type: 'operation' }>,
  now: number,
) {
  const context = resolveRunEventContext(state, event);
  if (!context) return state;
  let operationEntryId: string | null = null;
  const stateWithTimeline = updateSession(state, context.sessionId, (currentSession) => {
    const { session: sessionWithTimeline, entry } = upsertOperationTimelineEntry(currentSession, event, now);
    operationEntryId = entry.id;
    return sessionWithTimeline;
  });
  return operationEntryId
    ? updateExistingRun(stateWithTimeline, event.requestId, (currentRun) =>
        addTimelineEntryId({
          ...currentRun,
          phase: event.phase === 'started' || event.phase === 'updated'
            ? 'using_tool'
            : currentRun.phase,
        }, operationEntryId!))
    : stateWithTimeline;
}

function applySubagentMessageDeltaEvent(
  state: TuiState,
  event: Extract<LocalAgentEvent, { type: 'subagent.message.delta' }>,
) {
  const token = event.text;
  if (!token) return state;
  const context = resolveRunEventContext(state, event);
  if (!context) return state;
  const stateWithMessage = updateSession(state, context.sessionId, (currentSession) => {
    const { session: sessionWithMessage } = appendSubagentMessageDelta(
      currentSession,
      event.requestId,
      token,
    );
    return sessionWithMessage;
  });
  return updateExistingRun(stateWithMessage, event.requestId, (currentRun) => ({
    ...currentRun,
    phase: currentRun.phase === 'waiting_human' ? currentRun.phase : 'streaming',
    charCount: currentRun.charCount + token.length,
  }));
}

function applyHumanReviewRequestedEvent(
  state: TuiState,
  event: Extract<LocalAgentEvent, { type: 'human_review.requested' }>,
) {
  const context = resolveRunEventContext(state, event);
  if (!context) return state;
  const petId = event.actor?.petId || undefined;
  const reviews = event.reviews?.length ? event.reviews : [event.review];
  const stateWithReview = {
    ...state,
    connection: {
      ...state.connection,
      message: TUI_TEXT.approvalWaiting(petId),
    },
  };
  return updateExistingRun(stateWithReview, event.requestId, (currentRun) => ({
    ...currentRun,
    phase: 'waiting_human',
    charCount: 0,
    pendingReview: {
      requestId: event.requestId,
      review: reviews[0] ?? event.review,
      reviews,
      reviewIndex: 0,
      decisions: [],
      ...(petId ? { petId } : {}),
    },
  }));
}

function applySystemNoticeEvent(
  state: TuiState,
  event: Extract<LocalAgentEvent, { type: 'system.notice' }>,
  messageCell?: MessageCellMeta,
) {
  const context = resolveRunEventContext(state, event);
  if (!context) return state;
  const notice = formatSystemNoticeEvent(event);
  return notice
    ? updateSession(state, context.sessionId, (currentSession) =>
        appendMessageCells(currentSession, [
          messageDraft('system', notice, messageCell, `${event.requestId}:notice`, event.requestId),
        ]))
    : state;
}

function applyStudioProgressEvent(
  state: TuiState,
  event: Extract<LocalAgentEvent, { type: 'studio.progress' }>,
  messageCell?: MessageCellMeta,
) {
  const context = resolveRunEventContext(state, event);
  if (!context) return state;
  const line = formatStudioProgressEvent(event);
  return line
    ? updateSession(state, context.sessionId, (currentSession) =>
        appendMessageCells(currentSession, [
          messageDraft('system', line, messageCell, `${event.requestId}:studio-progress`, event.requestId),
        ]))
    : state;
}

function applyRuntimeErrorEvent(
  state: TuiState,
  event: Extract<LocalAgentEvent, { type: 'error' }>,
  messageCell?: MessageCellMeta,
) {
  const context = resolveRunEventContext(state, event);
  if (!context) return state;
  const message = event.message || 'internal error';
  return finishRun(state, event.requestId, TUI_TEXT.statusErrorRecovered, [
    messageDraft('system', TUI_TEXT.errorLine(message), messageCell, `${event.requestId}:event-error`, event.requestId),
  ]);
}

function applyRuntimeEvent(
  state: TuiState,
  action: Extract<TuiAction, { type: 'event.received' }>,
) {
  const event = action.event;
  switch (event.type) {
    case 'message.delta':
      return applyAssistantMessageDeltaEvent(state, event, action.messageCell);
    case 'message.completed':
      return applyAssistantMessageCompletedEvent(state, event, action.messageCell);
    case 'operation':
      return applyOperationEvent(state, event, action.now);
    case 'subagent.message.delta':
      return applySubagentMessageDeltaEvent(state, event);
    case 'human_review.requested':
      return applyHumanReviewRequestedEvent(state, event);
    case 'system.notice':
      return applySystemNoticeEvent(state, event, action.messageCell);
    case 'studio.progress':
      return applyStudioProgressEvent(state, event, action.messageCell);
    case 'error':
      return applyRuntimeErrorEvent(state, event, action.messageCell);
    default:
      return state;
  }
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
  if (!run?.pendingReview) {
    return null;
  }
  const reviewIndex = run.pendingReview.reviewIndex;
  const currentReview = run.pendingReview.reviews[reviewIndex] ?? run.pendingReview.review;
  return {
    requestId: run.pendingReview.requestId,
    review: currentReview,
    reviews: run.pendingReview.reviews,
    reviewIndex: run.pendingReview.reviewIndex,
    decisions: run.pendingReview.decisions,
    ...(run.pendingReview.petId ? { petId: run.pendingReview.petId } : {}),
  };
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

function normalizeSnapshotRunStartedAt(
  startedAt: number | undefined,
  existingRun: TuiRunModel | undefined,
  now: number,
) {
  const normalizedStartedAt = normalizeSnapshotTimestamp(startedAt, now);
  if (normalizedStartedAt !== null) return normalizedStartedAt;
  const existingStartedAt = normalizeSnapshotTimestamp(existingRun?.startedAt, now);
  return existingStartedAt ?? now;
}

function normalizeSnapshotTimestamp(value: number | undefined, now: number) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return null;
  const timestamp = shouldTreatAsEpochSeconds(value, now) ? value * 1000 : value;
  if (timestamp > now) return null;
  if (now - timestamp > MAX_REASONABLE_ELAPSED_MS) return null;
  return timestamp;
}

function shouldTreatAsEpochSeconds(value: number, now: number) {
  return now >= 1_000_000_000_000
    && value >= 1_000_000_000
    && value < 10_000_000_000;
}

function runFromSnapshot(
  snapshot: TuiCoreSessionSnapshot,
  run: TuiCoreRunSnapshot,
  existingRun: TuiRunModel | undefined,
  now: number,
): TuiRunModel | null {
  const phase = activeRunPhaseFromSnapshot(run);
  if (!phase) return null;
  return {
    requestId: run.requestId,
    sessionId: run.sessionId || snapshot.sessionId,
    kind: run.kind,
    phase,
    timelineEntryIds: run.timelineEntryIds,
    startedAt: normalizeSnapshotRunStartedAt(run.startedAt, existingRun, now),
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
    const reviews = pendingReview.reviews?.length ? pendingReview.reviews : [pendingReview.review];
    return {
      pendingReview: {
        requestId: pendingReview.requestId,
        review: reviews[0] ?? pendingReview.review,
        reviews,
        reviewIndex: 0,
        decisions: [],
        ...(pendingReview.petId ? { petId: pendingReview.petId } : {}),
      },
    };
  }
  return existingRun?.pendingReview
    ? { pendingReview: existingRun.pendingReview }
    : {};
}

function applySessionSnapshot(
  state: TuiState,
  action: Extract<TuiAction, { type: typeof TUI_CORE_TARGET_ACTIONS.sessionSnapshotLoaded }>,
) {
  const snapshot = action.snapshot;
  const now = typeof action.now === 'number' && Number.isFinite(action.now)
    ? action.now
    : Date.now();
  const sessionId = snapshot.sessionId;
  const existingSession = state.sessions[sessionId];
  const focusedSession = state.focusedSessionId ? state.sessions[state.focusedSessionId] : undefined;
  const baseSession = existingSession ?? focusedSession;
  const timeline = agentTimelineEntriesFromSnapshot(snapshot.timeline);
  const preservesTransientSnapshotState = action.source === 'reconnect'
    || action.source === 'reconcile';
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
    const nextRun = runFromSnapshot(snapshot, run, state.runs[run.requestId], now);
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
    activeRunId,
    tokenUsage: snapshot.tokenUsage
      ?? (preservesTransientSnapshotState ? existingSession?.tokenUsage ?? null : null),
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
    ui: action.source === 'resume'
      ? {
          mode: 'chat' as const,
          studioConversationId: null,
          externalEditorOpen: false,
        }
      : state.ui,
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
  requestId?: RunId,
): MessageCellDraft {
  return {
    id: meta?.id ?? fallbackId,
    kind,
    text,
    ...(requestId ? { requestId } : {}),
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
      const userDraft = messageDraft('user', action.userText, action.userCell, `${action.requestId}:user`, action.requestId);
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

    case 'review.action.advance': {
      const existingRun = state.runs[action.requestId];
      const sessionId = existingRun?.sessionId ?? state.focusedSessionId;
      if (!sessionId || !existingRun?.pendingReview) return state;
      const pendingReview = existingRun.pendingReview;
      const reviews = pendingReview.reviews;
      const nextIndex = Math.min(pendingReview.reviewIndex + 1, reviews.length - 1);
      const userDraft = messageDraft('user', action.message, action.userCell, `${action.requestId}:review-response:${nextIndex}`, action.requestId);
      const nextRun = addTimelineEntryId({
        ...existingRun,
        phase: 'waiting_human',
        pendingReview: {
          ...pendingReview,
          reviews,
          review: reviews[nextIndex] ?? pendingReview.review,
          reviewIndex: nextIndex,
          decisions: [
            ...pendingReview.decisions,
            action.decision,
          ],
        },
      }, `message:${userDraft.id}`);
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
      }, sessionId, (session) =>
        appendMessageCells({
          ...session,
          activeRunId: action.requestId,
        }, [
          userDraft,
        ]));
    }

    case 'review.response.resume': {
      const existingRun = state.runs[action.requestId];
      const sessionId = existingRun?.sessionId ?? state.focusedSessionId;
      if (!sessionId) return state;
      const userDraft = messageDraft('user', action.message, action.userCell, `${action.requestId}:review-response`, action.requestId);
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
      const stateWithRun = updateExistingRun(state, action.requestId, (currentRun) => ({
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

    case 'event.received':
      return applyRuntimeEvent(state, action);

    case 'server.interrupted':
      return finishRun(state, action.requestId, action.statusMessage, [
        messageDraft('assistant', TUI_TEXT.interrupted, action.messageCell, `${action.requestId}:interrupted`, action.requestId),
      ]);

    case 'server.studio_response': {
      const messages: MessageCellDraft[] = [
        action.reply.trim()
          ? messageDraft('assistant', action.reply.trim(), action.messageCell, `${action.requestId}:studio-response`, action.requestId)
          : messageDraft(
              'system',
              TUI_TEXT.studioEmptyTurn(action.outcome),
              action.messageCell,
              `${action.requestId}:studio-empty`,
              action.requestId,
            ),
      ];
      if (action.outcome === 'stopped' && action.reason) {
        messages.push(messageDraft(
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
        messageDraft('system', TUI_TEXT.studioErrorLine(action.message || 'studio error'), action.messageCell, `${action.requestId}:studio-error`, action.requestId),
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
