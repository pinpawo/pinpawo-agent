import { isTokenUsageSnapshot, type ReviewSpec } from '@pinpawo/pet-agent';
import {
  LOCAL_AGENT_SESSION_SNAPSHOT_VERSION,
  type LocalAgentOperationEntry,
  type LocalAgentReviewAction,
  type LocalAgentRunActivity,
  type LocalAgentRunView,
  type LocalAgentRuntimeView,
  type LocalAgentSession,
  type LocalAgentSessionSnapshot,
  type LocalAgentSessionSummary,
  type LocalAgentTimelineEntry,
} from './localAgentSession';

export function parseLocalAgentSessionSnapshot(
  value: unknown,
): LocalAgentSessionSnapshot | null {
  if (!isRecord(value)) return null;
  if (value.version !== LOCAL_AGENT_SESSION_SNAPSHOT_VERSION) return null;
  const session = parseLocalAgentSession(value.session);
  return session
    ? { version: LOCAL_AGENT_SESSION_SNAPSHOT_VERSION, session }
    : null;
}

export function parseLocalAgentSessionSummary(
  value: unknown,
): LocalAgentSessionSummary | null {
  if (!isRecord(value)) return null;
  if (
    typeof value.id !== 'string'
    || !isSessionKind(value.kind)
    || typeof value.title !== 'string'
    || typeof value.messageCount !== 'number'
    || !Number.isSafeInteger(value.messageCount)
    || value.messageCount < 0
    || typeof value.createdAt !== 'string'
    || typeof value.updatedAt !== 'string'
    || typeof value.active !== 'boolean'
  ) {
    return null;
  }
  return {
    id: value.id,
    kind: value.kind,
    title: value.title,
    messageCount: value.messageCount,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    active: value.active,
  };
}

function parseLocalAgentSession(value: unknown): LocalAgentSession | null {
  if (!isRecord(value)) return null;
  if (
    typeof value.sessionId !== 'string'
    || !isSessionKind(value.kind)
    || !Array.isArray(value.timeline)
    || (value.activeRun !== null && !isRecord(value.activeRun))
  ) {
    return null;
  }
  const timeline = value.timeline.flatMap((entry) => {
    const parsed = parseLocalAgentTimelineEntry(entry);
    return parsed ? [parsed] : [];
  });
  if (timeline.length !== value.timeline.length) return null;
  const activeRun = value.activeRun === null ? null : parseLocalAgentRun(value.activeRun);
  if (value.activeRun !== null && !activeRun) return null;
  const actor = isRecord(value.actor)
    && typeof value.actor.label === 'string'
    && typeof value.actor.summary === 'string'
    ? { label: value.actor.label, summary: value.actor.summary }
    : null;
  if (value.actor !== undefined && !actor) return null;
  const runtime = value.runtime === undefined
    ? undefined
    : parseLocalAgentRuntime(value.runtime);
  if (value.runtime !== undefined && !runtime) return null;
  const sessionTokenUsage = isTokenUsageSnapshot(value.sessionTokenUsage)
    && value.sessionTokenUsage.scope === 'session'
    ? value.sessionTokenUsage as LocalAgentSession['sessionTokenUsage']
    : undefined;
  return {
    sessionId: value.sessionId,
    kind: value.kind,
    timeline,
    activeRun,
    ...(actor ? { actor } : {}),
    ...(runtime ? { runtime } : {}),
    ...(isTokenUsageSnapshot(value.tokenUsage) ? { tokenUsage: value.tokenUsage } : {}),
    ...(sessionTokenUsage ? { sessionTokenUsage } : {}),
  };
}

function parseLocalAgentRuntime(value: unknown): LocalAgentRuntimeView | null {
  if (!isRecord(value)) return null;
  const stringFields = [
    'model',
    'cwd',
    'workspaceId',
    'workspaceName',
    'workspaceRoot',
    'stateRoot',
    'studioConfigPath',
    'studioDueRunsPath',
    'petsDir',
    'studioWikiBaseDir',
  ] as const;
  if (stringFields.some((field) =>
    value[field] !== undefined && typeof value[field] !== 'string')) {
    return null;
  }
  if (
    value.contextWindow !== undefined
    && (
      typeof value.contextWindow !== 'number'
      || !Number.isSafeInteger(value.contextWindow)
      || value.contextWindow <= 0
    )
  ) {
    return null;
  }
  return {
    ...(typeof value.model === 'string' ? { model: value.model } : {}),
    ...(typeof value.cwd === 'string' ? { cwd: value.cwd } : {}),
    ...(typeof value.workspaceId === 'string' ? { workspaceId: value.workspaceId } : {}),
    ...(typeof value.workspaceName === 'string' ? { workspaceName: value.workspaceName } : {}),
    ...(typeof value.workspaceRoot === 'string' ? { workspaceRoot: value.workspaceRoot } : {}),
    ...(typeof value.stateRoot === 'string' ? { stateRoot: value.stateRoot } : {}),
    ...(typeof value.studioConfigPath === 'string' ? { studioConfigPath: value.studioConfigPath } : {}),
    ...(typeof value.studioDueRunsPath === 'string' ? { studioDueRunsPath: value.studioDueRunsPath } : {}),
    ...(typeof value.petsDir === 'string' ? { petsDir: value.petsDir } : {}),
    ...(typeof value.studioWikiBaseDir === 'string' ? { studioWikiBaseDir: value.studioWikiBaseDir } : {}),
    ...(typeof value.contextWindow === 'number' ? { contextWindow: value.contextWindow } : {}),
  };
}

function parseLocalAgentTimelineEntry(value: unknown): LocalAgentTimelineEntry | null {
  if (!isRecord(value) || typeof value.id !== 'string') {
    return null;
  }
  if (value.type === 'message') {
    if (
      (value.role !== 'user'
        && value.role !== 'assistant'
        && value.role !== 'system'
        && value.role !== 'subagent')
      || (value.role === 'subagent' && typeof value.requestId !== 'string')
      || typeof value.text !== 'string'
      || (value.status !== 'streaming' && value.status !== 'completed')
    ) {
      return null;
    }
    return {
      id: value.id,
      type: 'message',
      role: value.role,
      text: value.text,
      status: value.status,
      ...(typeof value.requestId === 'string' ? { requestId: value.requestId } : {}),
      ...(typeof value.createdAt === 'string' ? { createdAt: value.createdAt } : {}),
      ...(typeof value.updatedAt === 'string' ? { updatedAt: value.updatedAt } : {}),
    };
  }
  if (value.type === 'operation') {
    if (
      typeof value.requestId !== 'string'
      || typeof value.operationKey !== 'string'
      || !isOperationPhase(value.phase)
      || (value.raw !== undefined && !isRecord(value.raw))
    ) {
      return null;
    }
    const operationSource = parseOperationSource(value.operationSource);
    if (value.operationSource !== undefined && !operationSource) return null;
    return {
      id: value.id,
      type: 'operation',
      requestId: value.requestId,
      operationKey: value.operationKey,
      kind: typeof value.kind === 'string' ? value.kind : value.operationKey,
      title: typeof value.title === 'string' ? value.title : value.operationKey,
      phase: value.phase,
      ...(typeof value.target === 'string' ? { target: value.target } : {}),
      ...(typeof value.summary === 'string' ? { summary: value.summary } : {}),
      ...(isRecord(value.details) ? { details: value.details } : {}),
      ...(operationSource ? { operationSource } : {}),
      ...(typeof value.startedAt === 'number' ? { startedAt: value.startedAt } : {}),
      ...(typeof value.updatedAt === 'number' ? { updatedAt: value.updatedAt } : {}),
      ...(typeof value.completedAt === 'number' ? { completedAt: value.completedAt } : {}),
      ...(isRecord(value.raw) ? {
        raw: {
          ...('input' in value.raw ? { input: value.raw.input } : {}),
          ...('output' in value.raw ? { output: value.raw.output } : {}),
          ...('error' in value.raw ? { error: value.raw.error } : {}),
        },
      } : {}),
    } satisfies LocalAgentOperationEntry;
  }
  return null;
}

function parseOperationSource(
  value: unknown,
): LocalAgentOperationEntry['operationSource'] | null {
  if (
    !isRecord(value)
    || (value.provider !== 'toolkit' && value.provider !== 'toolset' && value.provider !== 'runtime')
    || typeof value.name !== 'string'
    || (value.toolName !== undefined && typeof value.toolName !== 'string')
    || (value.callId !== undefined && typeof value.callId !== 'string')
  ) {
    return null;
  }
  return {
    provider: value.provider,
    name: value.name,
    ...(typeof value.toolName === 'string' ? { toolName: value.toolName } : {}),
    ...(typeof value.callId === 'string' ? { callId: value.callId } : {}),
  };
}

function parseLocalAgentRun(value: unknown): LocalAgentRunView | null {
  if (!isRecord(value) || typeof value.requestId !== 'string') {
    return null;
  }
  const base = {
    requestId: value.requestId,
    ...(typeof value.startedAt === 'number' ? { startedAt: value.startedAt } : {}),
    ...(typeof value.updatedAt === 'number' ? { updatedAt: value.updatedAt } : {}),
  };
  if (value.state === 'running') {
    if (!isRunActivity(value.activity) || value.reviewAction !== undefined) return null;
    return { ...base, state: 'running', activity: value.activity };
  }
  if (value.state === 'waiting_review') {
    const reviewAction = parseNativeReviewAction(value.reviewAction);
    if (!reviewAction || value.activity !== undefined) return null;
    return { ...base, state: 'waiting_review', reviewAction };
  }
  if (value.state === 'interrupting') {
    if (value.activity !== undefined || value.reviewAction !== undefined) return null;
    return { ...base, state: 'interrupting' };
  }
  return null;
}

function parseNativeReviewAction(value: unknown): LocalAgentReviewAction | null {
  if (!isRecord(value)) return null;
  const reviews = readReviewSpecs(value.reviews);
  if (typeof value.actionId !== 'string' || !reviews) {
    return null;
  }
  return {
    actionId: value.actionId,
    reviews,
    ...(typeof value.petId === 'string' ? { petId: value.petId } : {}),
  };
}

function readReviewSpecs(value: unknown): ReviewSpec[] | null {
  if (!Array.isArray(value)) return null;
  const reviews = value.filter((item): item is ReviewSpec =>
    Boolean(item && typeof item === 'object' && !Array.isArray(item)
      && typeof (item as Record<string, unknown>).id === 'string'));
  return reviews.length === value.length && reviews.length > 0 ? reviews : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isSessionKind(value: unknown): value is LocalAgentSession['kind'] {
  return value === 'chat' || value === 'studio';
}

function isOperationPhase(value: unknown): value is LocalAgentOperationEntry['phase'] {
  return value === 'started'
    || value === 'updated'
    || value === 'completed'
    || value === 'failed'
    || value === 'interrupted';
}

function isRunActivity(value: unknown): value is LocalAgentRunActivity {
  return value === 'thinking'
    || value === 'using_tool'
    || value === 'streaming';
}
