import type { TokenUsageSnapshot } from '@pinpawo/agent-contracts';
import type { AgentRuntimeEvent } from './events';
import type {
  AgentMessageEntry,
  AgentOperationEntry,
  AgentPlan,
  AgentRunView,
  AgentSession,
  AgentSessionMessageInput,
  AgentTimelineEntry,
} from './domain';
import type { AgentSessionSnapshot } from './snapshot';
import { agentOperationEntryFromEvent, agentOperationEntryId } from './timeline';
import { reviewActionId, reviewActionReviews } from './review';

export type AgentSessionInput =
  | {
      type: 'session.configured';
      kind?: AgentSession['kind'];
      actor?: NonNullable<AgentSession['actor']>;
      runtime?: NonNullable<AgentSession['runtime']>;
    }
  | {
      type: 'session.cleared';
    }
  | {
      type: 'user.accepted';
      requestId: string;
      kind: AgentSession['kind'];
      text: string;
      message?: Omit<AgentSessionMessageInput, 'role' | 'text' | 'requestId'>;
    }
  | {
      type: 'message.appended';
      message: AgentSessionMessageInput;
    }
  | {
      type: 'runtime.event';
      event: AgentRuntimeEvent;
      message?: AgentSessionMessageInput;
    }
  | {
      type: 'run.interrupting';
      requestId: string;
    }
  | {
      type: 'run.finished';
      requestId: string;
      messages?: AgentSessionMessageInput[];
      tokenUsage?: TokenUsageSnapshot | null;
    };

export type AgentSessionReductionContext = {
  observedAt: number;
};

export type AgentSessionSnapshotApplyOptions = {
  observedAt?: number;
  preserveOmittedTokenUsage?: boolean;
  preserveOmittedSessionTokenUsage?: boolean;
};

export function reduceSession(
  session: AgentSession,
  input: AgentSessionInput,
  context: AgentSessionReductionContext,
): AgentSession {
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
        ...omitAllTokenUsage(session),
        kind: 'chat',
        timeline: [],
        activeRun: null,
        currentPlan: null,
      };
    case 'user.accepted':
      return acceptUserInput(session, input, context);
    case 'message.appended':
      return appendMessage(session, input.message, context);
    case 'runtime.event':
      return reduceRuntimeEvent(session, input.event, input.message, context);
    case 'run.interrupting':
      return updateOwnedRun(session, input.requestId, (run) => ({
        ...runViewBase(run),
        state: 'interrupting',
        ...observedAtUpdate(context),
      }));
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
  session: AgentSession,
  snapshot: AgentSessionSnapshot,
  options: AgentSessionSnapshotApplyOptions = {},
): AgentSession {
  const incoming = snapshot.session;
  const context = options.observedAt === undefined
    ? undefined
    : { observedAt: options.observedAt };
  const runtime = {
    ...(session.runtime ?? {}),
    ...(incoming.runtime ?? {}),
  };
  const actor = incoming.actor ?? session.actor;
  const preserveSessionTokenUsage = options.preserveOmittedSessionTokenUsage
    ?? options.preserveOmittedTokenUsage;
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
    ...(incoming.currentPlan !== undefined
      ? { currentPlan: cloneAgentPlan(incoming.currentPlan) }
      : {}),
    ...(Object.keys(runtime).length ? { runtime } : {}),
    ...(incoming.tokenUsage
      ? { tokenUsage: incoming.tokenUsage }
      : options.preserveOmittedTokenUsage && session.tokenUsage
        ? { tokenUsage: session.tokenUsage }
        : {}),
    ...(incoming.sessionTokenUsage
      ? { sessionTokenUsage: incoming.sessionTokenUsage }
      : preserveSessionTokenUsage && session.sessionTokenUsage
        ? { sessionTokenUsage: session.sessionTokenUsage }
        : {}),
  };
}

function acceptUserInput(
  session: AgentSession,
  input: Extract<AgentSessionInput, { type: 'user.accepted' }>,
  context: AgentSessionReductionContext,
) {
  const withoutUsage = omitRunTokenUsage(session);
  const message = input.message ?? {};
  return appendMessage({
    ...withoutUsage,
    kind: input.kind,
    currentPlan: null,
    activeRun: {
      requestId: input.requestId,
      state: 'running',
      activity: 'thinking',
      startedAt: context.observedAt,
      updatedAt: context.observedAt,
    },
  }, {
    ...message,
    role: 'user',
    requestId: input.requestId,
    text: input.text,
  }, context);
}

function reduceRuntimeEvent(
  session: AgentSession,
  event: AgentRuntimeEvent,
  message: AgentSessionMessageInput | undefined,
  context: AgentSessionReductionContext,
): AgentSession {
  switch (event.type) {
    case 'message.delta':
      return appendAssistantDelta(session, event.requestId, event.messageId, event.text, message, context);
    case 'message.completed':
      return completeAssistantMessage(
        session,
        event.requestId,
        event.messageId,
        event.text,
        event.usage,
        message,
        context,
      );
    case 'operation':
      return applyOperationEvent(session, event, context);
    case 'plan.updated':
      return applyPlanUpdate(session, event);
    case 'subagent.message.completed':
      return appendSubagentMessage(session, event, context);
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
      }], undefined, context);
  }
}

function applyPlanUpdate(
  session: AgentSession,
  event: Extract<AgentRuntimeEvent, { type: 'plan.updated' }>,
) {
  if (!ownsRun(session, event.requestId)) return session;
  return {
    ...session,
    currentPlan: cloneAgentPlan(event.plan),
  };
}

function appendRuntimeSystemMessage(
  session: AgentSession,
  requestId: string,
  text: string,
  message: AgentSessionMessageInput | undefined,
  context: AgentSessionReductionContext,
) {
  if (!ownsRun(session, requestId) || !text.trim()) return session;
  return appendMessage(session, {
    ...(message ?? {}),
    role: 'system',
    requestId,
    text: message?.text ?? text,
  }, context);
}

function appendAssistantDelta(
  session: AgentSession,
  requestId: string,
  messageId: string,
  token: string,
  message: AgentSessionMessageInput | undefined,
  context: AgentSessionReductionContext,
) {
  if (!token || !ownsRun(session, requestId)) return session;
  const id = message?.id ?? assistantEntryId(requestId, messageId);
  const previous = findMessageEntry(session.timeline, id);
  const createdAt = message?.createdAt ?? observedAtIso(context.observedAt);
  const entry: AgentMessageEntry = {
    id,
    type: 'message',
    role: 'assistant',
    requestId,
    text: (previous?.text ?? '') + token,
    status: 'streaming',
    ...(previous?.createdAt
      ? { createdAt: previous.createdAt, ...(createdAt ? { updatedAt: createdAt } : {}) }
      : (createdAt ? { createdAt } : {})),
  };
  return updateOwnedRun({
    ...session,
    timeline: upsertTimelineEntry(session.timeline, entry),
  }, requestId, (run) => ({
    ...runViewBase(run),
    state: 'running',
    activity: 'streaming',
    ...observedAtUpdate(context),
  }));
}

function completeAssistantMessage(
  session: AgentSession,
  requestId: string,
  messageId: string,
  completedText: string,
  usage: TokenUsageSnapshot | undefined,
  message: AgentSessionMessageInput | undefined,
  context: AgentSessionReductionContext,
) {
  const ownsActiveRun = ownsRun(session, requestId);
  const recoveredFromTimeline = !ownsActiveRun && hasTimelineRequest(session, requestId);
  if (!ownsActiveRun && !recoveredFromTimeline) return session;
  if (recoveredFromTimeline && hasLocalInterruptReleaseNotice(session, requestId)) return session;
  const id = message?.id ?? assistantEntryId(requestId, messageId);
  const text = completedText.trim() || findMessageEntry(session.timeline, id)?.text.trim() || '...';
  const withMessage = finalizeAssistantMessage(session, requestId, id, text, message, context);
  if (ownsActiveRun) {
    return finishOwnedRun(withMessage, requestId, [], usage ?? null, context);
  }
  return usage ? applyTokenUsage(withMessage, usage) : withMessage;
}

function applyOperationEvent(
  session: AgentSession,
  event: Extract<AgentRuntimeEvent, { type: 'operation' }>,
  context: AgentSessionReductionContext,
) {
  if (!ownsRun(session, event.requestId)) return session;
  // A starting operation no longer has to settle the streaming reply: assistant
  // entries are keyed by their upstream message id, so text that resumes after
  // a tool belongs to a new id and never appends to the pre-tool paragraph.
  const entryId = agentOperationEntryId(event);
  const previous = session.timeline.find((entry): entry is AgentOperationEntry =>
    entry.type === 'operation' && entry.id === entryId);
  const operation = agentOperationEntryFromEvent(event, context.observedAt, previous);
  const withOperation = {
    ...session,
    timeline: upsertTimelineEntry(session.timeline, operation),
  };
  return updateOwnedRun(withOperation, event.requestId, (run) => {
    if (event.phase === 'started' || event.phase === 'updated') {
      return {
        ...runViewBase(run),
        state: 'running',
        activity: 'using_tool',
        ...observedAtUpdate(context),
      };
    }
    if (run.state === 'waiting_review') {
      return {
        ...runViewBase(run),
        state: 'running',
        activity: 'thinking',
        ...observedAtUpdate(context),
      };
    }
    if (run.state === 'running') {
      return {
        ...runViewBase(run),
        state: 'running',
        activity: hasOpenOperation(withOperation.timeline, event.requestId)
          ? 'using_tool'
          : 'thinking',
        ...observedAtUpdate(context),
      };
    }
    return {
      ...run,
      ...observedAtUpdate(context),
    };
  });
}

function hasOpenOperation(
  timeline: readonly AgentTimelineEntry[],
  requestId: string,
) {
  return timeline.some((entry) => (
    entry.type === 'operation'
    && entry.requestId === requestId
    && (entry.phase === 'started' || entry.phase === 'updated')
  ));
}

function appendSubagentMessage(
  session: AgentSession,
  event: Extract<AgentRuntimeEvent, { type: 'subagent.message.completed' }>,
  context: AgentSessionReductionContext,
) {
  if (!event.text.trim() || !ownsRun(session, event.requestId)) return session;
  const namespace = event.namespace.filter(Boolean).join('|');
  const sourceId = event.messageId.trim();
  const id = `${event.requestId}:subagent:${namespace ? `${namespace}:` : ''}${sourceId}`;
  const previous = session.timeline.find((candidate): candidate is AgentMessageEntry =>
    candidate.type === 'message' && candidate.id === id);
  const entry: AgentMessageEntry = {
    id,
    type: 'message',
    role: 'subagent',
    requestId: event.requestId,
    text: event.text,
    status: 'completed',
    ...(previous?.createdAt
      ? { createdAt: previous.createdAt }
      : createdAtField(undefined, context)),
  };
  const withMessage = {
    ...session,
    timeline: upsertTimelineEntry(session.timeline, entry),
  };
  return updateOwnedRun(withMessage, event.requestId, (run) => ({
    ...runViewBase(run),
    state: 'running',
    activity: 'streaming',
    ...observedAtUpdate(context),
  }));
}

function applyReviewRequest(
  session: AgentSession,
  event: Extract<AgentRuntimeEvent, { type: 'human_review.requested' }>,
  context: AgentSessionReductionContext,
) {
  const reviews = reviewActionReviews(event.review, event.reviews);
  const actionId = reviewActionId({
    requestId: event.requestId,
    ...(event.interruptId ? { interruptId: event.interruptId } : {}),
    reviews,
  });
  const petId = event.actor?.petId;
  return updateOwnedRun(session, event.requestId, (run) => ({
    ...runViewBase(run),
    state: 'waiting_review',
    reviewAction: {
      actionId,
      reviews,
      ...(petId ? { petId } : {}),
    },
    ...observedAtUpdate(context),
  }));
}

function runViewBase(run: AgentRunView) {
  return {
    requestId: run.requestId,
    ...(run.startedAt !== undefined ? { startedAt: run.startedAt } : {}),
    ...(run.updatedAt !== undefined ? { updatedAt: run.updatedAt } : {}),
  };
}

function finishOwnedRun(
  session: AgentSession,
  requestId: string,
  messages: AgentSessionMessageInput[],
  tokenUsage: TokenUsageSnapshot | null | undefined,
  context: AgentSessionReductionContext,
) {
  if (!ownsRun(session, requestId)) return session;
  let nextSession: AgentSession = {
    ...session,
    timeline: finalizeRunMessages(session.timeline, requestId),
    activeRun: null,
  };
  for (const message of messages) {
    nextSession = appendMessage(nextSession, {
      ...message,
      requestId: message.requestId ?? requestId,
    }, context);
  }
  if (tokenUsage === undefined) return nextSession;
  if (tokenUsage === null) return omitRunTokenUsage(nextSession);
  return applyTokenUsage(nextSession, tokenUsage);
}

function appendMessage(
  session: AgentSession,
  message: AgentSessionMessageInput,
  context: AgentSessionReductionContext,
) {
  if (!message.text) return session;
  const entry: AgentMessageEntry = {
    id: message.id ?? defaultMessageId(session, message),
    type: 'message',
    role: message.role,
    text: message.text,
    status: 'completed',
    ...(message.requestId ? { requestId: message.requestId } : {}),
    ...createdAtField(message.createdAt, context),
  };
  return { ...session, timeline: [...session.timeline, entry] };
}

function finalizeAssistantMessage(
  session: AgentSession,
  requestId: string,
  id: string,
  text: string,
  message: AgentSessionMessageInput | undefined,
  context: AgentSessionReductionContext,
) {
  const previous = findMessageEntry(session.timeline, id);
  const updatedAt = message?.createdAt ?? observedAtIso(context.observedAt);
  const entry: AgentMessageEntry = {
    id,
    type: 'message',
    role: 'assistant',
    requestId,
    text,
    status: 'completed',
    ...(previous
      ? {
          ...(previous.createdAt ? { createdAt: previous.createdAt } : {}),
          ...(updatedAt ? { updatedAt } : {}),
        }
      : createdAtField(message?.createdAt, context)),
  };
  return { ...session, timeline: upsertTimelineEntry(session.timeline, entry) };
}

/**
 * A finished run leaves nothing mid-flight: any message still marked streaming
 * is settled so an interrupted or failed run cannot strand the view in a
 * streaming state. Keyed entries make this a flat pass — no position lookup.
 */
function finalizeRunMessages(timeline: AgentTimelineEntry[], requestId: string) {
  return timeline.map((entry) =>
    entry.type === 'message' && entry.requestId === requestId && entry.status === 'streaming'
      ? { ...entry, status: 'completed' as const }
      : entry);
}

function applyTokenUsage(session: AgentSession, usage: TokenUsageSnapshot) {
  const contextWindow = usage.scope !== 'run'
    && usage.contextWindow === undefined
    && session.runtime?.contextWindow !== undefined
    ? session.runtime.contextWindow
    : usage.contextWindow;
  const tokenUsage = contextWindow === undefined ? usage : { ...usage, contextWindow };
  const sessionTokenUsage = accumulateSessionTokenUsage(
    session.sessionTokenUsage,
    tokenUsage,
    session.runtime?.contextWindow,
  );
  return {
    ...session,
    ...(contextWindow === undefined
      ? {}
      : { runtime: { ...(session.runtime ?? {}), contextWindow } }),
    tokenUsage,
    sessionTokenUsage,
  };
}

function accumulateSessionTokenUsage(
  current: AgentSession['sessionTokenUsage'],
  usage: TokenUsageSnapshot,
  runtimeContextWindow: number | undefined,
): NonNullable<AgentSession['sessionTokenUsage']> {
  if (usage.scope === 'session') {
    return { ...usage, scope: 'session' };
  }
  const contextWindow = usage.contextWindow ?? current?.contextWindow ?? runtimeContextWindow;
  const latestInputTokens = usage.latestInputTokens ?? current?.latestInputTokens;
  return {
    inputTokens: (current?.inputTokens ?? 0) + usage.inputTokens,
    outputTokens: (current?.outputTokens ?? 0) + usage.outputTokens,
    totalTokens: (current?.totalTokens ?? 0) + usage.totalTokens,
    ...(latestInputTokens !== undefined ? { latestInputTokens } : {}),
    ...(contextWindow !== undefined ? { contextWindow } : {}),
    ...(usage.updatedAt !== undefined ? { updatedAt: usage.updatedAt } : {}),
    ...(usage.source !== undefined ? { source: usage.source } : {}),
    scope: 'session',
  };
}

function omitRunTokenUsage(session: AgentSession): AgentSession {
  const { tokenUsage: _tokenUsage, ...withoutUsage } = session;
  void _tokenUsage;
  return withoutUsage;
}

function omitAllTokenUsage(session: AgentSession): AgentSession {
  const {
    tokenUsage: _tokenUsage,
    sessionTokenUsage: _sessionTokenUsage,
    ...withoutUsage
  } = session;
  void _tokenUsage;
  void _sessionTokenUsage;
  return withoutUsage;
}

function updateOwnedRun(
  session: AgentSession,
  requestId: string,
  update: (run: AgentRunView) => AgentRunView,
) {
  if (!ownsRun(session, requestId) || !session.activeRun) return session;
  const nextRun = update(session.activeRun);
  return nextRun === session.activeRun ? session : { ...session, activeRun: nextRun };
}

function ownsRun(session: AgentSession, requestId: string) {
  return session.activeRun?.requestId === requestId;
}

function hasTimelineRequest(session: AgentSession, requestId: string) {
  return session.timeline.some((entry) => entry.requestId === requestId);
}

function hasLocalInterruptReleaseNotice(session: AgentSession, requestId: string) {
  return session.timeline.some((entry) =>
    entry.type === 'message'
      && entry.role === 'system'
      && entry.id === `message:${requestId}:interrupt-local-release`);
}

/** Assistant entries are addressed by the upstream model lifecycle id. */
function assistantEntryId(requestId: string, messageId: string) {
  return `${requestId}:assistant:${messageId}`;
}

function findMessageEntry(timeline: AgentTimelineEntry[], id: string) {
  return timeline.find((entry): entry is AgentMessageEntry =>
    entry.type === 'message' && entry.id === id);
}

function countMessages(
  timeline: AgentTimelineEntry[],
  requestId: string | undefined,
  role: AgentMessageEntry['role'],
) {
  return timeline.filter((entry) =>
    entry.type === 'message' && entry.requestId === requestId && entry.role === role).length;
}

function defaultMessageId(session: AgentSession, message: AgentSessionMessageInput) {
  const owner = message.requestId ?? session.sessionId;
  return `${owner}:message:${message.role}:${countMessages(session.timeline, message.requestId, message.role)}`;
}

function upsertTimelineEntry(
  timeline: AgentTimelineEntry[],
  entry: AgentTimelineEntry,
) {
  const index = timeline.findIndex((item) => item.id === entry.id);
  if (index < 0) return [...timeline, entry];
  return [...timeline.slice(0, index), entry, ...timeline.slice(index + 1)];
}

function cloneTimelineEntry(entry: AgentTimelineEntry): AgentTimelineEntry {
  if (entry.type === 'message') return { ...entry };
  return {
    ...entry,
    ...(entry.details ? { details: { ...entry.details } } : {}),
    ...(entry.operationSource ? { operationSource: { ...entry.operationSource } } : {}),
    ...(entry.raw ? { raw: { ...entry.raw } } : {}),
  };
}

function cloneAgentPlan(plan: AgentPlan | null) {
  return plan
    ? { items: plan.items.map((item) => ({ ...item })) }
    : null;
}

const MAX_RECONCILED_RUN_AGE_MS = 24 * 60 * 60 * 1000;

function normalizeSnapshotRun(
  incoming: AgentRunView,
  existing: AgentRunView | null,
  context: AgentSessionReductionContext | undefined,
): AgentRunView {
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

function observedAtUpdate(context: AgentSessionReductionContext) {
  return context.observedAt > 0 ? { updatedAt: context.observedAt } : {};
}

function createdAtField(
  createdAt: string | undefined,
  context: AgentSessionReductionContext,
) {
  const value = createdAt ?? observedAtIso(context.observedAt);
  return value ? { createdAt: value } : {};
}

function observedAtIso(observedAt: number) {
  return observedAt > 0 ? new Date(observedAt).toISOString() : undefined;
}
