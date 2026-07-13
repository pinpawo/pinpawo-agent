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
} from '../timeline/agentTimeline';
import type {
  LocalAgentMessageEntry,
  LocalAgentOperationEntry,
  LocalAgentRun,
  LocalAgentSession,
  LocalAgentTimelineEntry,
} from '../../localAgentSession';
import { MAX_REASONABLE_ELAPSED_MS } from '../render/terminalText';
import {
  agentTimelineEntriesFromSnapshot,
} from '../snapshot/tuiSessionSnapshot';
import { selectActiveOperationsFromTimeline } from '../timeline/agentTimelineSelectors';
import { currentReview, reviewActionId } from '../../reviewAction';
import type {
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

function appendOrUpdateTimelineEntry(
  timeline: LocalAgentTimelineEntry[],
  entry: LocalAgentTimelineEntry,
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
  timeline: LocalAgentTimelineEntry[],
  requestId: string,
  role: LocalAgentMessageEntry['role'],
) {
  return timeline.filter((entry) =>
    entry.type === 'message'
      && entry.requestId === requestId
      && entry.role === role).length;
}

function findStreamingAssistantIndex(timeline: LocalAgentTimelineEntry[], requestId: string) {
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

function findSessionForRun(state: TuiState, requestId: string) {
  for (const [sessionId, session] of Object.entries(state.sessions)) {
    if (session.activeRun?.requestId === requestId) {
      return { sessionId, session };
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
  const runOwner = findSessionForRun(state, requestId);
  if (runOwner) {
    return {
      requestId,
      sessionId: runOwner.sessionId,
      run: runOwner.session.activeRun,
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
    const current = session.timeline[streamingIndex] as LocalAgentMessageEntry;
    const entry: LocalAgentMessageEntry = {
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

  const entry: LocalAgentMessageEntry = {
    id: `${requestId}:assistant:${countTimelineMessagesForRequest(session.timeline, requestId, 'assistant')}`,
    type: 'message',
    role: 'assistant',
    requestId,
    text: token,
    status: 'streaming',
    source: 'live-event',
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
    const current = session.timeline[streamingIndex] as LocalAgentMessageEntry;
    const entry: LocalAgentMessageEntry = {
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

  const entry: LocalAgentMessageEntry = {
    id: `${requestId}:assistant:${countTimelineMessagesForRequest(session.timeline, requestId, 'assistant')}`,
    type: 'message',
    role: 'assistant',
    requestId,
    text,
    status: 'completed',
    source: 'live-event',
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
  const current = session.timeline[streamingIndex] as LocalAgentMessageEntry;
  const entry: LocalAgentMessageEntry = {
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
): { session: SessionModel; entry: LocalAgentOperationEntry } {
  const sessionWithSettledAssistant = event.phase === 'started'
    ? settleStreamingAssistantTimelineEntry(session, event.requestId)
    : session;
  const id = timelineEntryIdFromOperationEvent(event);
  const previous = sessionWithSettledAssistant.timeline.find((entry): entry is LocalAgentOperationEntry =>
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

function appendSubagentMessageDelta(
  session: SessionModel,
  requestId: string,
  token: string,
): { session: SessionModel; entryId?: string } {
  const id = `${requestId}:subagent-output`;
  const previous = session.timeline.find((entry): entry is LocalAgentMessageEntry =>
    entry.type === 'message'
      && entry.role === 'subagent'
      && entry.id === id);
  const text = (previous?.text ?? '') + token;
  const hasContent = Boolean(formatSubagentMessage(text));
  if (!hasContent) return { session };
  const message: LocalAgentMessageEntry = {
    id,
    type: 'message',
    role: 'subagent',
    requestId,
    text,
    status: 'streaming',
    source: 'live-event',
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
  const owner = findSessionForRun(state, requestId);
  const activeRun = owner?.session.activeRun;
  if (!owner || !activeRun) return state;
  return updateSession(state, owner.sessionId, (session) => ({
    ...session,
    activeRun: updater(activeRun),
  }));
}

function removeReviewDraft(state: TuiState, actionId: string | undefined) {
  if (!actionId || !state.reviewDrafts[actionId]) return state;
  const { [actionId]: _removed, ...reviewDrafts } = state.reviewDrafts;
  void _removed;
  return { ...state, reviewDrafts };
}

function removeRun(state: TuiState, requestId: string) {
  const owner = findSessionForRun(state, requestId);
  if (!owner) return state;
  return updateSession(state, owner.sessionId, (session) => ({
    ...session,
    activeRun: session.activeRun?.requestId === requestId ? null : session.activeRun,
  }));
}

function finishRun(
  state: TuiState,
  requestId: string,
  statusMessage: string,
  messages: MessageCellDraft[] = [],
  tokenUsage?: TokenUsageModel | null,
) {
  const owner = findSessionForRun(state, requestId);
  if (!owner) return state;
  const sessionId = owner.sessionId;
  const session = state.sessions[sessionId];
  if (!session) return state;
  const reviewActionIdToRemove = owner.session.activeRun?.reviewAction?.actionId;
  const nextState = updateSession(state, sessionId, (sessionToUpdate) => {
    const finalizedSession = sessionToUpdate.activeRun?.requestId === requestId
      ? finalizeSubagentMessages(sessionToUpdate, requestId)
      : sessionToUpdate;
    return appendMessageCells({
      ...finalizedSession,
      activeRun: sessionToUpdate.activeRun?.requestId === requestId ? null : sessionToUpdate.activeRun,
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
  const stateWithRunRemoved = removeReviewDraft(
    removeRun(stateWithRouteRemoved, requestId),
    reviewActionIdToRemove,
  );

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
    ? updateExistingRun(stateWithTimeline, event.requestId, (run) => ({
        ...run,
        phase: 'streaming',
      }))
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
  const owner = findSessionForRun(state, event.requestId);
  return owner?.session.activeRun
    ? { run: owner.session.activeRun, sessionId: owner.sessionId }
    : null;
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
    ? updateExistingRun(stateWithTimeline, event.requestId, (currentRun) => ({
        ...currentRun,
        phase: event.phase === 'started' || event.phase === 'updated'
          ? 'using_tool'
          : currentRun.phase,
      }))
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
  const actionId = reviewActionId({
    requestId: event.requestId,
    ...(event.interruptId ? { interruptId: event.interruptId } : {}),
    reviews,
  });
  const stateWithReview = {
    ...state,
    connection: {
      ...state.connection,
      message: TUI_TEXT.approvalWaiting(petId),
    },
  };
  const previousReviewActionId = context.run.reviewAction?.actionId;
  const nextState = updateExistingRun(stateWithReview, event.requestId, (currentRun) => ({
    ...currentRun,
    phase: 'waiting_human',
    reviewAction: {
      actionId,
      reviews,
      status: 'waiting',
      ...(petId ? { petId } : {}),
    },
  }));
  const stateWithoutPreviousDraft = removeReviewDraft(nextState, previousReviewActionId);
  return {
    ...stateWithoutPreviousDraft,
    reviewDrafts: {
      ...stateWithoutPreviousDraft.reviewDrafts,
      [actionId]: { actionId, decisions: [] },
    },
  };
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

function clearReviewAction(run: LocalAgentRun): LocalAgentRun {
  if (!run.reviewAction) return run;
  const { reviewAction, ...rest } = run;
  void reviewAction;
  return rest;
}

function activeRunToPendingApproval(state: TuiState, run: LocalAgentRun | null) {
  if (!run?.reviewAction || run.reviewAction.status !== 'waiting') {
    return null;
  }
  const draft = state.reviewDrafts[run.reviewAction.actionId];
  if (!draft) return null;
  const review = currentReview(run.reviewAction, draft);
  if (!review) return null;
  return {
    requestId: run.requestId,
    actionId: run.reviewAction.actionId,
    reviews: run.reviewAction.reviews,
    status: run.reviewAction.status,
    ...(run.reviewAction.petId ? { petId: run.reviewAction.petId } : {}),
    review,
    decisions: draft.decisions,
  };
}

function normalizeSnapshotRunStartedAt(
  startedAt: number | undefined,
  existingRun: LocalAgentRun | undefined,
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
  run: LocalAgentRun,
  existingRun: LocalAgentRun | undefined,
  now: number,
): LocalAgentRun {
  return {
    ...run,
    startedAt: normalizeSnapshotRunStartedAt(run.startedAt, existingRun, now),
  };
}

function applySessionSnapshot(
  state: TuiState,
  action: Extract<TuiAction, { type: 'session.snapshot.loaded' }>,
) {
  const snapshot = action.snapshot.session;
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
  const existingRun = existingSession?.activeRun
    && snapshot.activeRun
    && existingSession.activeRun.requestId === snapshot.activeRun.requestId
    ? existingSession.activeRun
    : undefined;
  const activeRun = snapshot.activeRun
    ? runFromSnapshot(snapshot.activeRun, existingRun ?? undefined, now)
    : null;
  const nextSession: SessionModel = {
    sessionId,
    kind: snapshot.kind,
    actor: snapshot.actor ?? baseSession?.actor ?? {
      label: TUI_TEXT.defaultPetName,
      summary: TUI_TEXT.defaultPetSummary,
    },
    runtime: {
      ...(baseSession?.runtime ?? {}),
      ...(snapshot.runtime ?? {}),
    },
    timeline,
    activeRun,
    tokenUsage: snapshot.tokenUsage
      ?? (preservesTransientSnapshotState ? existingSession?.tokenUsage ?? null : null),
  };

  const nextSessions = {
    ...state.sessions,
    [sessionId]: nextSession,
  };
  const nextReviewDrafts = { ...state.reviewDrafts };
  const previousReviewActionId = existingSession?.activeRun?.reviewAction?.actionId;
  if (previousReviewActionId) {
    delete nextReviewDrafts[previousReviewActionId];
  }
  const snapshotReviewAction = activeRun?.reviewAction;
  if (snapshotReviewAction?.reviews.length) {
    // ReviewDraft is intentionally client-local. Every authoritative snapshot
    // restarts the ordered review action at its first undecided review.
    nextReviewDrafts[snapshotReviewAction.actionId] = {
      actionId: snapshotReviewAction.actionId,
      decisions: [],
    };
  }
  for (const clearedSessionId of sessionIdsToClear) {
    if (clearedSessionId === sessionId) continue;
    const clearedSession = nextSessions[clearedSessionId];
    if (clearedSession?.activeRun) {
      const clearedReviewActionId = clearedSession.activeRun.reviewAction?.actionId;
      if (clearedReviewActionId) {
        delete nextReviewDrafts[clearedReviewActionId];
      }
      nextSessions[clearedSessionId] = {
        ...clearedSession,
        activeRun: null,
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
    reviewDrafts: nextReviewDrafts,
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
    case 'session.snapshot.loaded':
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
        const reviewActionIdToRemove = sessionId
          ? state.sessions[sessionId]?.activeRun?.reviewAction?.actionId
          : undefined;
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
          activeRun: null,
          tokenUsage: null,
        }));
        return removeReviewDraft(nextState, reviewActionIdToRemove);
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
      const reviewActionIdToRemove = state.sessions[sessionId]?.activeRun?.reviewAction?.actionId;
      const userDraft = messageDraft('user', action.userText, action.userCell, `${action.requestId}:user`, action.requestId);
      const nextState = updateSession({
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
      }, sessionId, (session) => appendMessageCells({
        ...session,
        kind: action.kind,
        activeRun: {
          requestId: action.requestId,
          phase: 'thinking',
          startedAt: action.now,
        },
        tokenUsage: null,
      }, [
        userDraft,
      ]));
      return removeReviewDraft(nextState, reviewActionIdToRemove);
    }

    case 'review.draft.record': {
      const owner = findSessionForRun(state, action.requestId);
      const existingRun = owner?.session.activeRun;
      if (!owner || !existingRun?.reviewAction || existingRun.reviewAction.actionId !== action.actionId) return state;
      const existingDraft = state.reviewDrafts[action.actionId]
        ?? { actionId: action.actionId, decisions: [] };
      const nextRun: TuiRunModel = {
        ...existingRun,
        phase: 'waiting_human',
      };
      const nextState = updateExistingRun({
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
      }, action.requestId, () => nextRun);
      return {
        ...nextState,
        reviewDrafts: {
          ...nextState.reviewDrafts,
          [action.actionId]: {
            ...existingDraft,
            decisions: [...existingDraft.decisions, action.decision],
          },
        },
      };
    }

    case 'review.action.submit': {
      const owner = findSessionForRun(state, action.requestId);
      const existingRun = owner?.session.activeRun;
      if (!owner || !existingRun?.reviewAction || existingRun.reviewAction.actionId !== action.actionId) return state;
      const existingDraft = state.reviewDrafts[action.actionId]
        ?? { actionId: action.actionId, decisions: [] };
      const nextRun: TuiRunModel = {
        ...existingRun,
        phase: 'thinking',
        reviewAction: {
          ...existingRun.reviewAction,
          status: 'submitting',
        },
      };
      const nextState = updateExistingRun({
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
      }, action.requestId, () => nextRun);
      return {
        ...nextState,
        reviewDrafts: {
          ...nextState.reviewDrafts,
          [action.actionId]: {
            ...existingDraft,
            decisions: [...existingDraft.decisions, action.decision],
          },
        },
      };
    }

    case 'review.action.cancel': {
      const existingRun = findSessionForRun(state, action.requestId)?.session.activeRun;
      if (!existingRun?.reviewAction || existingRun.reviewAction.actionId !== action.actionId) return state;
      return updateExistingRun({
        ...state,
        connection: {
          ...state.connection,
          message: action.statusMessage,
        },
      }, action.requestId, () => ({
        ...existingRun,
        phase: 'interrupting',
        reviewAction: {
          ...existingRun.reviewAction!,
          status: 'canceling',
        },
      }));
    }

    case 'run.interrupting':
    case 'server.interrupting': {
      const run = findSessionForRun(state, action.requestId)?.session.activeRun;
      if (!run) return state;
      const reviewActionIdToRemove = run.reviewAction?.actionId;
      const stateWithRun = updateExistingRun(state, action.requestId, (currentRun) => ({
        ...clearReviewAction(currentRun),
        phase: 'interrupting',
      }));
      const stateWithoutDraft = removeReviewDraft(stateWithRun, reviewActionIdToRemove);
      return {
        ...stateWithoutDraft,
        connection: {
          ...stateWithoutDraft.connection,
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
  return session?.activeRun ?? null;
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
