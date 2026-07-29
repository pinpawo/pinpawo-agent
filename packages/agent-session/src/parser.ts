import type { ReviewSpec } from '@pinpawo/pet-agent';
import {
  AGENT_SESSION_SNAPSHOT_VERSION,
  type AgentOperationEntry,
  type AgentReviewAction,
  type AgentRunActivity,
  type AgentRunView,
  type AgentRuntimeView,
  type AgentSession,
  type AgentSessionSummary,
} from './domain';
import type {
  AgentSessionSnapshot,
  JsonObject,
} from './snapshot';
import { isJsonValue } from './snapshot';
import {
  isAgentTokenUsageSnapshot,
  isBuiltinGlobalReviewPolicyMode,
} from './validation';

export function parseAgentSessionSnapshot(
  value: unknown,
): AgentSessionSnapshot | null {
  if (!isRecord(value)) return null;
  if (value.version !== AGENT_SESSION_SNAPSHOT_VERSION) return null;
  const session = parseAgentSession(value.session);
  return session
    ? { version: AGENT_SESSION_SNAPSHOT_VERSION, session }
    : null;
}

export function parseAgentSessionSummary(
  value: unknown,
): AgentSessionSummary | null {
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

function parseAgentSession(value: unknown): AgentSession | null {
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
    const parsed = parseAgentTimelineEntry(entry);
    return parsed ? [parsed] : [];
  });
  if (timeline.length !== value.timeline.length) return null;
  const activeRun = value.activeRun === null ? null : parseAgentRun(value.activeRun);
  if (value.activeRun !== null && !activeRun) return null;
  const actor = isRecord(value.actor)
    && typeof value.actor.label === 'string'
    && typeof value.actor.summary === 'string'
    ? { label: value.actor.label, summary: value.actor.summary }
    : null;
  if (value.actor !== undefined && !actor) return null;
  const runtime = value.runtime === undefined
    ? undefined
    : parseAgentRuntime(value.runtime);
  if (value.runtime !== undefined && !runtime) return null;
  const sessionTokenUsage = isAgentTokenUsageSnapshot(value.sessionTokenUsage)
    && value.sessionTokenUsage.scope === 'session'
    ? value.sessionTokenUsage as AgentSession['sessionTokenUsage']
    : undefined;
  return {
    sessionId: value.sessionId,
    kind: value.kind,
    timeline,
    activeRun,
    ...(actor ? { actor } : {}),
    ...(runtime ? { runtime } : {}),
    ...(isAgentTokenUsageSnapshot(value.tokenUsage) ? { tokenUsage: value.tokenUsage } : {}),
    ...(sessionTokenUsage ? { sessionTokenUsage } : {}),
  };
}

function parseAgentRuntime(value: unknown): AgentRuntimeView | null {
  if (!isRecord(value)) return null;
  const stringFields = [
    'model',
    'modelProfileId',
    'modelProfileLabel',
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
    value.modelProfileAvailable !== undefined
    && typeof value.modelProfileAvailable !== 'boolean'
  ) {
    return null;
  }
  if (
    value.modelProfileIssues !== undefined
    && (
      !Array.isArray(value.modelProfileIssues)
      || !value.modelProfileIssues.every((issue) => typeof issue === 'string')
    )
  ) {
    return null;
  }
  if (
    value.inputModalities !== undefined
    && (
      !Array.isArray(value.inputModalities)
      || value.inputModalities.length === 0
      || !value.inputModalities.every((item) => item === 'text' || item === 'image')
    )
  ) {
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
  if (
    value.globalReviewPolicyMode !== undefined
    && !isBuiltinGlobalReviewPolicyMode(value.globalReviewPolicyMode)
  ) {
    return null;
  }
  return {
    ...(typeof value.modelProfileId === 'string'
      ? { modelProfileId: value.modelProfileId }
      : {}),
    ...(typeof value.modelProfileLabel === 'string'
      ? { modelProfileLabel: value.modelProfileLabel }
      : {}),
    ...(typeof value.modelProfileAvailable === 'boolean'
      ? { modelProfileAvailable: value.modelProfileAvailable }
      : {}),
    ...(Array.isArray(value.modelProfileIssues)
      ? { modelProfileIssues: [...value.modelProfileIssues] as string[] }
      : {}),
    ...(typeof value.model === 'string' ? { model: value.model } : {}),
    ...(Array.isArray(value.inputModalities)
      ? { inputModalities: value.inputModalities as AgentRuntimeView['inputModalities'] }
      : {}),
    ...(isBuiltinGlobalReviewPolicyMode(value.globalReviewPolicyMode)
      ? { globalReviewPolicyMode: value.globalReviewPolicyMode }
      : {}),
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

function parseAgentTimelineEntry(
  value: unknown,
): AgentSession['timeline'][number] | null {
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
      || !isOptionalFiniteNumber(value.startedAt)
      || !isOptionalFiniteNumber(value.updatedAt)
      || !isOptionalFiniteNumber(value.completedAt)
    ) {
      return null;
    }
    const operationSource = parseOperationSource(value.operationSource);
    if (value.operationSource !== undefined && !operationSource) return null;
    const details = value.details === undefined
      ? undefined
      : readJsonObject(value.details);
    if (value.details !== undefined && !details) return null;
    const raw = value.raw === undefined
      ? undefined
      : parseOperationRaw(value.raw);
    if (value.raw !== undefined && !raw) return null;
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
      ...(details ? { details } : {}),
      ...(operationSource ? { operationSource } : {}),
      ...(isFiniteNumber(value.startedAt) ? { startedAt: value.startedAt } : {}),
      ...(isFiniteNumber(value.updatedAt) ? { updatedAt: value.updatedAt } : {}),
      ...(isFiniteNumber(value.completedAt) ? { completedAt: value.completedAt } : {}),
      ...(raw ? { raw } : {}),
    } satisfies AgentOperationEntry;
  }
  return null;
}

function parseOperationRaw(value: unknown) {
  if (!isRecord(value)) return null;
  const allowedKeys = ['input', 'output', 'error'];
  if (Object.keys(value).some((key) => !allowedKeys.includes(key))) return null;
  const input = 'input' in value && isJsonValue(value.input)
    ? value.input
    : undefined;
  const output = 'output' in value && isJsonValue(value.output)
    ? value.output
    : undefined;
  const error = 'error' in value && isJsonValue(value.error)
    ? value.error
    : undefined;
  if (
    ('input' in value && input === undefined)
    || ('output' in value && output === undefined)
    || ('error' in value && error === undefined)
  ) {
    return null;
  }
  return {
    ...(input !== undefined ? { input } : {}),
    ...(output !== undefined ? { output } : {}),
    ...(error !== undefined ? { error } : {}),
  };
}

function readJsonObject(value: unknown): JsonObject | null {
  return isRecord(value) && isJsonValue(value)
    ? value
    : null;
}

function parseOperationSource(
  value: unknown,
): AgentOperationEntry['operationSource'] | null {
  if (
    !isRecord(value)
    || (value.provider !== 'toolkit' && value.provider !== 'runtime')
    || typeof value.name !== 'string'
    || (value.toolName !== undefined && typeof value.toolName !== 'string')
    || (value.callId !== undefined && typeof value.callId !== 'string')
  ) {
    return null;
  }
  return {
    provider: value.provider === 'runtime' ? 'runtime' : 'toolkit',
    name: value.name,
    ...(typeof value.toolName === 'string' ? { toolName: value.toolName } : {}),
    ...(typeof value.callId === 'string' ? { callId: value.callId } : {}),
  };
}

function parseAgentRun(value: unknown): AgentRunView | null {
  if (
    !isRecord(value)
    || typeof value.requestId !== 'string'
    || !isOptionalFiniteNumber(value.startedAt)
    || !isOptionalFiniteNumber(value.updatedAt)
  ) {
    return null;
  }
  const base = {
    requestId: value.requestId,
    ...(isFiniteNumber(value.startedAt) ? { startedAt: value.startedAt } : {}),
    ...(isFiniteNumber(value.updatedAt) ? { updatedAt: value.updatedAt } : {}),
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

function parseNativeReviewAction(value: unknown): AgentReviewAction | null {
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
      && typeof (item as Record<string, unknown>).id === 'string'
      && isJsonValue(item)));
  return reviews.length === value.length && reviews.length > 0 ? reviews : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isSessionKind(value: unknown): value is AgentSession['kind'] {
  return value === 'chat' || value === 'studio';
}

function isOperationPhase(value: unknown): value is AgentOperationEntry['phase'] {
  return value === 'started'
    || value === 'updated'
    || value === 'completed'
    || value === 'failed'
    || value === 'interrupted';
}

function isRunActivity(value: unknown): value is AgentRunActivity {
  return value === 'thinking'
    || value === 'using_tool'
    || value === 'streaming';
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isOptionalFiniteNumber(value: unknown) {
  return value === undefined || isFiniteNumber(value);
}
