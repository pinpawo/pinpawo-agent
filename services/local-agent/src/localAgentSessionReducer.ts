import type { TokenUsageSnapshot } from '@pinpawo/pet-agent';
import type { LocalAgentRuntimeEvent } from './events/localAgentRuntimeEvent';
import type {
  LocalAgentMessageEntry,
  LocalAgentOperationEntry,
  LocalAgentRun,
  LocalAgentSession,
  LocalAgentSessionMessageInput,
  LocalAgentSessionSnapshot,
  LocalAgentTimelineEntry,
} from './localAgentSession';
import { localAgentOperationEntryFromEvent, localAgentOperationEntryId } from './localAgentTimeline';
import { reviewActionId, reviewActionReviews } from './reviewAction';

export type LocalAgentSessionInput =
  | {
      type: 'session.configured';
      kind?: LocalAgentSession['kind'];
      actor?: NonNullable<LocalAgentSession['actor']>;
      runtime?: NonNullable<LocalAgentSession['runtime']>;
    }
  | {
      type: 'session.cleared';
    }
  | {
      type: 'user.accepted';
      requestId: string;
      kind: LocalAgentSession['kind'];
      text: string;
      message?: Omit<LocalAgentSessionMessageInput, 'role' | 'text' | 'requestId'>;
    }
  | {
      type: 'message.appended';
      message: LocalAgentSessionMessageInput;
    }
  | {
      type: 'runtime.event';
      event: LocalAgentRuntimeEvent;
      message?: LocalAgentSessionMessageInput;
    }
  | {
      type: 'review.submitted';
      requestId: string;
      actionId: string;
    }
  | {
      type: 'review.canceled';
      requestId: string;
      actionId: string;
    }
  | {
      type: 'run.interrupting';
      requestId: string;
    }
  | {
      type: 'run.finished';
      requestId: string;
      messages?: LocalAgentSessionMessageInput[];
      tokenUsage?: TokenUsageSnapshot | null;
    };

export type LocalAgentSessionReductionContext = {
  observedAt: number;
};

export type LocalAgentSessionSnapshotApplyOptions = {
  observedAt?: number;
  preserveOmittedTokenUsage?: boolean;
};

export function reduceSession(
  session: LocalAgentSession,
  input: LocalAgentSessionInput,
  context: LocalAgentSessionReductionContext,
): LocalAgentSession {
  switch (input.type) {
    case 'session.configured':
      return {
        ...session,
        ...(input.kind ? { kind: input.kind } : {}),
        ...(input.actor ? { actor: input.actor } : {}),
        ...(input.runtime
          ? { runtime: { ...(session.runtime ?? {}), ...input.runtime } }
          : {}),
      };
    case 'session.cleared':
      return {
        ...omitTokenUsage(session),
        kind: 'chat',
        timeline: [],
        activeRun: null,
      };
    case 'user.accepted':
      return acceptUserInput(session, input, context);
    case 'message.appended':
      return appendMessage(session, input.message, context);
    case 'runtime.event':
      return reduceRuntimeEvent(session, input.event, input.message, context);
    case 'review.submitted':
      return updateOwnedRun(session, input.requestId, (run) => {
        if (run.reviewAction?.actionId !== input.actionId) return run;
        return {
          ...run,
          phase: 'thinking',
          reviewAction: { ...run.reviewAction, status: 'submitting' },
          ...observedAtUpdate(context),
        };
      });
    case 'review.canceled':
      return updateOwnedRun(session, input.requestId, (run) => {
        if (run.reviewAction?.actionId !== input.actionId) return run;
        return {
          ...run,
          phase: 'interrupting',
          reviewAction: { ...run.reviewAction, status: 'canceling' },
          ...observedAtUpdate(context),
        };
      });
    case 'run.interrupting':
      return updateOwnedRun(session, input.requestId, (run) => {
        const { reviewAction: _reviewAction, ...runWithoutReview } = run;
        void _reviewAction;
        return {
          ...runWithoutReview,
          phase: 'interrupting',
          ...observedAtUpdate(context),
        };
      });
    case 'run.finished':
      return finishOwnedRun(
        session,
        input.requestId,
        input.messages ?? [],
        input.tokenUsage,
        context,
      );
  }
}

export function applySessionSnapshot(
  session: LocalAgentSession,
  snapshot: LocalAgentSessionSnapshot,
  options: LocalAgentSessionSnapshotApplyOptions = {},
): LocalAgentSession {
  const incoming = snapshot.session;
  const context = options.observedAt === undefined
    ? undefined
    : { observedAt: options.observedAt };
  const runtime = {
    ...(session.runtime ?? {}),
    ...(incoming.runtime ?? {}),
  };
  const actor = incoming.actor ?? session.actor;
  return {
    sessionId: incoming.sessionId,
    kind: incoming.kind,
    ...(actor ? { actor } : {}),
    // Snapshots replace the whole ordered projection. Live-only operation and
    // subagent entries are intentionally dropped when checkpoint data omits them.
    timeline: incoming.timeline.map(cloneTimelineEntry),
    activeRun: incoming.activeRun
      ? normalizeSnapshotRun(incoming.activeRun, session.activeRun, context)
      : null,
    ...(Object.keys(runtime).length ? { runtime } : {}),
    ...(incoming.tokenUsage
      ? { tokenUsage: incoming.tokenUsage }
      : options.preserveOmittedTokenUsage && session.tokenUsage
        ? { tokenUsage: session.tokenUsage }
        : {}),
  };
}

function acceptUserInput(
  session: LocalAgentSession,
  input: Extract<LocalAgentSessionInput, { type: 'user.accepted' }>,
  context: LocalAgentSessionReductionContext,
) {
  const withoutUsage = omitTokenUsage(session);
  const message = input.message ?? {};
  return appendMessage({
    ...withoutUsage,
    kind: input.kind,
    activeRun: {
      requestId: input.requestId,
      phase: 'thinking',
      startedAt: context.observedAt,
      updatedAt: context.observedAt,
    },
  }, {
    ...message,
    role: 'user',
    requestId: input.requestId,
    text: input.text,
    source: message.source ?? 'local-input',
  }, context);
}

function reduceRuntimeEvent(
  session: LocalAgentSession,
  event: LocalAgentRuntimeEvent,
  message: LocalAgentSessionMessageInput | undefined,
  context: LocalAgentSessionReductionContext,
): LocalAgentSession {
  switch (event.type) {
    case 'message.delta':
      return appendAssistantDelta(session, event.requestId, event.text, message, context);
    case 'message.completed':
      return completeAssistantMessage(session, event.requestId, event.text, event.usage, message, context);
    case 'operation':
      return applyOperationEvent(session, event, context);
    case 'subagent.message.delta':
      return appendSubagentDelta(session, event.requestId, event.text, context);
    case 'human_review.requested':
      return applyReviewRequest(session, event, context);
    case 'system.notice':
      return appendRuntimeSystemMessage(session, event.requestId, event.message, message, context);
    case 'studio.progress':
      return message ? appendMessage(session, message, context) : session;
    case 'error':
      return finishOwnedRun(session, event.requestId, [{
        ...(message ?? {}),
        role: 'system',
        requestId: event.requestId,
        text: message?.text ?? event.message ?? 'internal error',
        source: message?.source ?? 'live-event',
      }], undefined, context);
  }
}

function appendRuntimeSystemMessage(
  session: LocalAgentSession,
  requestId: string,
  text: string,
  message: LocalAgentSessionMessageInput | undefined,
  context: LocalAgentSessionReductionContext,
) {
  if (!ownsRun(session, requestId) || !text.trim()) return session;
  return appendMessage(session, {
    ...(message ?? {}),
    role: 'system',
    requestId,
    text: message?.text ?? text,
    source: message?.source ?? 'live-event',
  }, context);
}

function appendAssistantDelta(
  session: LocalAgentSession,
  requestId: string,
  token: string,
  message: LocalAgentSessionMessageInput | undefined,
  context: LocalAgentSessionReductionContext,
) {
  if (!token || !ownsRun(session, requestId)) return session;
  const streamingIndex = findStreamingAssistantIndex(session.timeline, requestId);
  const createdAt = message?.createdAt ?? observedAtIso(context.observedAt);
  const nextTimeline = [...session.timeline];
  if (streamingIndex >= 0) {
    const current = nextTimeline[streamingIndex] as LocalAgentMessageEntry;
    nextTimeline[streamingIndex] = {
      ...current,
      text: current.text + token,
      ...(createdAt ? { updatedAt: createdAt } : {}),
    };
  } else {
    nextTimeline.push({
      id: message?.id ?? `${requestId}:assistant:${countMessages(session.timeline, requestId, 'assistant')}`,
      type: 'message',
      role: 'assistant',
      requestId,
      text: token,
      status: 'streaming',
      source: 'live-event',
      ...(createdAt ? { createdAt } : {}),
    });
  }
  return updateOwnedRun({ ...session, timeline: nextTimeline }, requestId, (run) => ({
    ...run,
    phase: 'streaming',
    ...observedAtUpdate(context),
  }));
}

function completeAssistantMessage(
  session: LocalAgentSession,
  requestId: string,
  completedText: string,
  usage: TokenUsageSnapshot | undefined,
  message: LocalAgentSessionMessageInput | undefined,
  context: LocalAgentSessionReductionContext,
) {
  const ownsActiveRun = ownsRun(session, requestId);
  const recoveredFromTimeline = !ownsActiveRun && hasTimelineRequest(session, requestId);
  if (!ownsActiveRun && !recoveredFromTimeline) return session;
  if (recoveredFromTimeline && hasLocalInterruptReleaseNotice(session, requestId)) return session;
  const fallbackText = findLatestAssistantText(session, requestId);
  const text = completedText.trim() || fallbackText || '...';
  const withMessage = finalizeAssistantMessage(session, requestId, text, message, context);
  if (ownsActiveRun) {
    return finishOwnedRun(withMessage, requestId, [], usage ?? null, context);
  }
  return usage ? applyTokenUsage(withMessage, usage) : withMessage;
}

function applyOperationEvent(
  session: LocalAgentSession,
  event: Extract<LocalAgentRuntimeEvent, { type: 'operation' }>,
  context: LocalAgentSessionReductionContext,
) {
  if (!ownsRun(session, event.requestId)) return session;
  const settledSession = event.phase === 'started'
    ? settleStreamingAssistant(session, event.requestId)
    : session;
  const entryId = localAgentOperationEntryId(event);
  const previous = settledSession.timeline.find((entry): entry is LocalAgentOperationEntry =>
    entry.type === 'operation' && entry.id === entryId);
  const operation = localAgentOperationEntryFromEvent(event, context.observedAt, previous);
  const withOperation = {
    ...settledSession,
    timeline: upsertTimelineEntry(settledSession.timeline, operation),
  };
  return updateOwnedRun(withOperation, event.requestId, (run) => ({
    ...run,
    phase: event.phase === 'started' || event.phase === 'updated' ? 'using_tool' : run.phase,
    ...observedAtUpdate(context),
  }));
}

function appendSubagentDelta(
  session: LocalAgentSession,
  requestId: string,
  token: string,
  context: LocalAgentSessionReductionContext,
) {
  if (!token || !ownsRun(session, requestId)) return session;
  const id = `${requestId}:subagent-output`;
  const previous = session.timeline.find((entry): entry is LocalAgentMessageEntry =>
    entry.type === 'message' && entry.role === 'subagent' && entry.id === id);
  const text = (previous?.text ?? '') + token;
  if (!text.trim()) return session;
  const entry: LocalAgentMessageEntry = {
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
  const withMessage = {
    ...session,
    timeline: upsertTimelineEntry(session.timeline, entry),
  };
  return updateOwnedRun(withMessage, requestId, (run) => ({
    ...run,
    phase: run.phase === 'waiting_human' ? run.phase : 'streaming',
    ...observedAtUpdate(context),
  }));
}

function applyReviewRequest(
  session: LocalAgentSession,
  event: Extract<LocalAgentRuntimeEvent, { type: 'human_review.requested' }>,
  context: LocalAgentSessionReductionContext,
) {
  const reviews = reviewActionReviews(event.review, event.reviews);
  const actionId = reviewActionId({
    requestId: event.requestId,
    ...(event.interruptId ? { interruptId: event.interruptId } : {}),
    reviews,
  });
  const petId = event.actor?.petId;
  return updateOwnedRun(session, event.requestId, (run) => ({
    ...run,
    phase: 'waiting_human',
    reviewAction: {
      actionId,
      reviews,
      status: 'waiting',
      ...(petId ? { petId } : {}),
    },
    ...observedAtUpdate(context),
  }));
}

function finishOwnedRun(
  session: LocalAgentSession,
  requestId: string,
  messages: LocalAgentSessionMessageInput[],
  tokenUsage: TokenUsageSnapshot | null | undefined,
  context: LocalAgentSessionReductionContext,
) {
  if (!ownsRun(session, requestId)) return session;
  let nextSession: LocalAgentSession = {
    ...session,
    timeline: finalizeSubagentMessages(session.timeline, requestId),
    activeRun: null,
  };
  for (const message of messages) {
    nextSession = appendMessage(nextSession, {
      ...message,
      requestId: message.requestId ?? requestId,
    }, context);
  }
  if (tokenUsage === undefined) return nextSession;
  if (tokenUsage === null) return omitTokenUsage(nextSession);
  return applyTokenUsage(nextSession, tokenUsage);
}

function appendMessage(
  session: LocalAgentSession,
  message: LocalAgentSessionMessageInput,
  context: LocalAgentSessionReductionContext,
) {
  if (!message.text) return session;
  const entry: LocalAgentMessageEntry = {
    id: message.id ?? defaultMessageId(session, message),
    type: 'message',
    role: message.role,
    text: message.text,
    status: 'completed',
    source: message.source ?? 'live-event',
    ...(message.requestId ? { requestId: message.requestId } : {}),
    ...createdAtField(message.createdAt, context),
  };
  return { ...session, timeline: [...session.timeline, entry] };
}

function finalizeAssistantMessage(
  session: LocalAgentSession,
  requestId: string,
  text: string,
  message: LocalAgentSessionMessageInput | undefined,
  context: LocalAgentSessionReductionContext,
) {
  const streamingIndex = findStreamingAssistantIndex(session.timeline, requestId);
  const nextTimeline = [...session.timeline];
  if (streamingIndex >= 0) {
    const current = nextTimeline[streamingIndex] as LocalAgentMessageEntry;
    const updatedAt = message?.createdAt ?? observedAtIso(context.observedAt);
    nextTimeline[streamingIndex] = {
      ...current,
      text,
      status: 'completed',
      ...(updatedAt ? { updatedAt } : {}),
    };
  } else {
    nextTimeline.push({
      id: message?.id ?? `${requestId}:assistant:${countMessages(session.timeline, requestId, 'assistant')}`,
      type: 'message',
      role: 'assistant',
      requestId,
      text,
      status: 'completed',
      source: 'live-event',
      ...createdAtField(message?.createdAt, context),
    });
  }
  return { ...session, timeline: nextTimeline };
}

function settleStreamingAssistant(session: LocalAgentSession, requestId: string) {
  const index = findStreamingAssistantIndex(session.timeline, requestId);
  if (index < 0) return session;
  const timeline = [...session.timeline];
  timeline[index] = { ...timeline[index] as LocalAgentMessageEntry, status: 'completed' };
  return { ...session, timeline };
}

function finalizeSubagentMessages(timeline: LocalAgentTimelineEntry[], requestId: string) {
  return timeline.map((entry) =>
    entry.type === 'message' && entry.role === 'subagent' && entry.requestId === requestId
      ? { ...entry, status: 'completed' as const }
      : entry);
}

function applyTokenUsage(session: LocalAgentSession, usage: TokenUsageSnapshot) {
  const contextWindow = usage.scope !== 'run'
    && usage.contextWindow === undefined
    && session.runtime?.contextWindow !== undefined
    ? session.runtime.contextWindow
    : usage.contextWindow;
  const tokenUsage = contextWindow === undefined ? usage : { ...usage, contextWindow };
  return {
    ...session,
    ...(contextWindow === undefined
      ? {}
      : { runtime: { ...(session.runtime ?? {}), contextWindow } }),
    tokenUsage,
  };
}

function omitTokenUsage(session: LocalAgentSession): LocalAgentSession {
  const { tokenUsage: _tokenUsage, ...withoutUsage } = session;
  void _tokenUsage;
  return withoutUsage;
}

function updateOwnedRun(
  session: LocalAgentSession,
  requestId: string,
  update: (run: LocalAgentRun) => LocalAgentRun,
) {
  if (!ownsRun(session, requestId) || !session.activeRun) return session;
  const nextRun = update(session.activeRun);
  return nextRun === session.activeRun ? session : { ...session, activeRun: nextRun };
}

function ownsRun(session: LocalAgentSession, requestId: string) {
  return session.activeRun?.requestId === requestId;
}

function hasTimelineRequest(session: LocalAgentSession, requestId: string) {
  return session.timeline.some((entry) => entry.requestId === requestId);
}

function hasLocalInterruptReleaseNotice(session: LocalAgentSession, requestId: string) {
  return session.timeline.some((entry) =>
    entry.type === 'message'
      && entry.role === 'system'
      && entry.id === `message:${requestId}:interrupt-local-release`);
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

function findLatestAssistantText(session: LocalAgentSession, requestId: string) {
  for (let index = session.timeline.length - 1; index >= 0; index -= 1) {
    const entry = session.timeline[index];
    if (entry.type === 'message' && entry.requestId === requestId && entry.role === 'assistant') {
      return entry.text.trim();
    }
  }
  return '';
}

function countMessages(
  timeline: LocalAgentTimelineEntry[],
  requestId: string | undefined,
  role: LocalAgentMessageEntry['role'],
) {
  return timeline.filter((entry) =>
    entry.type === 'message' && entry.requestId === requestId && entry.role === role).length;
}

function defaultMessageId(session: LocalAgentSession, message: LocalAgentSessionMessageInput) {
  const owner = message.requestId ?? session.sessionId;
  return `${owner}:message:${message.role}:${countMessages(session.timeline, message.requestId, message.role)}`;
}

function upsertTimelineEntry(
  timeline: LocalAgentTimelineEntry[],
  entry: LocalAgentTimelineEntry,
) {
  const index = timeline.findIndex((item) => item.id === entry.id);
  if (index < 0) return [...timeline, entry];
  return [...timeline.slice(0, index), entry, ...timeline.slice(index + 1)];
}

function cloneTimelineEntry(entry: LocalAgentTimelineEntry): LocalAgentTimelineEntry {
  if (entry.type === 'message') return { ...entry };
  return {
    ...entry,
    ...(entry.details ? { details: { ...entry.details } } : {}),
    ...(entry.operationSource ? { operationSource: { ...entry.operationSource } } : {}),
    ...(entry.raw ? { raw: { ...entry.raw } } : {}),
  };
}

const MAX_RECONCILED_RUN_AGE_MS = 24 * 60 * 60 * 1000;

function normalizeSnapshotRun(
  incoming: LocalAgentRun,
  existing: LocalAgentRun | null,
  context: LocalAgentSessionReductionContext | undefined,
): LocalAgentRun {
  const observedAt = context?.observedAt;
  const startedAt = normalizeSnapshotTimestamp(incoming.startedAt, observedAt)
    ?? (existing?.requestId === incoming.requestId
      ? normalizeSnapshotTimestamp(existing.startedAt, observedAt)
      : undefined)
    ?? (observedAt && observedAt > 0 ? observedAt : undefined);
  return {
    ...incoming,
    ...(startedAt !== undefined ? { startedAt } : {}),
  };
}

function normalizeSnapshotTimestamp(value: number | undefined, observedAt: number | undefined) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return undefined;
  const timestamp = value >= 1_000_000_000 && value < 10_000_000_000
    ? value * 1000
    : value;
  if (!observedAt || observedAt <= 0) return timestamp;
  if (timestamp > observedAt || observedAt - timestamp > MAX_RECONCILED_RUN_AGE_MS) {
    return undefined;
  }
  return timestamp;
}

function observedAtUpdate(context: LocalAgentSessionReductionContext) {
  return context.observedAt > 0 ? { updatedAt: context.observedAt } : {};
}

function createdAtField(
  createdAt: string | undefined,
  context: LocalAgentSessionReductionContext,
) {
  const value = createdAt ?? observedAtIso(context.observedAt);
  return value ? { createdAt: value } : {};
}

function observedAtIso(observedAt: number) {
  return observedAt > 0 ? new Date(observedAt).toISOString() : undefined;
}
