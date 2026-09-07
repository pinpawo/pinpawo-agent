import {
  HUMAN_REVIEW_REQUEST_SCHEMA_VERSION,
  parseHumanReviewRequest,
  type HumanReviewRequest,
} from '@pinpawo/agent-contracts';
import {
  AGENT_SESSION_SNAPSHOT_VERSION,
  type AgentOperationEntry,
  type AgentRunActivity,
  type AgentRunView,
  type AgentRuntimeView,
  type AgentSession,
  type AgentSessionSummary,
} from './domain';
import type { PendingInterruptProjection } from './review';
import type {
  AgentSessionSnapshot,
  JsonObject,
} from './snapshot';
import { isJsonValue } from './snapshot';
import {
  isAgentTokenUsageSnapshot,
  isAutoAuthorizationSafetyLevel,
  isBuiltinGlobalReviewPolicyMode,
  parseAgentPlan,
} from './validation';

export function parseAgentSessionSnapshot(
  value: unknown,
): AgentSessionSnapshot | null {
  if (!isRecord(value)) return null;
  if (
    value.version !== 3
    && value.version !== 4
    && value.version !== AGENT_SESSION_SNAPSHOT_VERSION
  ) return null;
  const readReviews = value.version === 3
    ? readLegacyReviewSpecs
    : readReviewSpecs;
  const session = parseAgentSession(value.session, readReviews, value.version);
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

type ReviewSpecsReader = (value: unknown) => HumanReviewRequest[] | null;

function parseAgentSession(
  value: unknown,
  readReviews: ReviewSpecsReader,
  version: 3 | 4 | typeof AGENT_SESSION_SNAPSHOT_VERSION,
): AgentSession | null {
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
  const parsedRun = value.activeRun === null
    ? { activeRun: null, pendingInterrupt: null }
    : parseAgentRun(value.activeRun, readReviews, version < 5);
  if (!parsedRun) return null;
  const canonicalPendingInterrupt = version === 5
    ? value.pendingInterrupt === null
      ? null
      : parsePendingInterrupt(value.pendingInterrupt, readReviews)
    : parsedRun.pendingInterrupt;
  if (
    version === 5
    && (
      value.pendingInterrupt === undefined
      || (value.pendingInterrupt !== null && !canonicalPendingInterrupt)
    )
  ) return null;
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
  const currentPlan = value.currentPlan === undefined
    ? undefined
    : value.currentPlan === null
      ? null
      : parseAgentPlan(value.currentPlan);
  if (value.currentPlan !== undefined && currentPlan === null && value.currentPlan !== null) {
    return null;
  }
  return {
    sessionId: value.sessionId,
    kind: value.kind,
    timeline,
    activeRun: parsedRun.activeRun,
    pendingInterrupt: canonicalPendingInterrupt,
    ...(currentPlan !== undefined ? { currentPlan } : {}),
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
    value.modelProfileCompatible !== undefined
    && typeof value.modelProfileCompatible !== 'boolean'
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
    value.requiredInputModalities !== undefined
    && (
      !Array.isArray(value.requiredInputModalities)
      || value.requiredInputModalities.length === 0
      || !value.requiredInputModalities.every(
        (item) => item === 'text' || item === 'image',
      )
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
    value.contextCompactionWatermarkTokens !== undefined
    && (
      typeof value.contextCompactionWatermarkTokens !== 'number'
      || !Number.isSafeInteger(value.contextCompactionWatermarkTokens)
      || value.contextCompactionWatermarkTokens <= 0
      || typeof value.contextWindow !== 'number'
      || value.contextCompactionWatermarkTokens > value.contextWindow
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
  if (
    value.autoAuthorizationSafetyLevel !== undefined
    && !isAutoAuthorizationSafetyLevel(value.autoAuthorizationSafetyLevel)
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
    ...(typeof value.modelProfileCompatible === 'boolean'
      ? { modelProfileCompatible: value.modelProfileCompatible }
      : {}),
    ...(Array.isArray(value.modelProfileIssues)
      ? { modelProfileIssues: [...value.modelProfileIssues] as string[] }
      : {}),
    ...(typeof value.model === 'string' ? { model: value.model } : {}),
    ...(Array.isArray(value.inputModalities)
      ? { inputModalities: value.inputModalities as AgentRuntimeView['inputModalities'] }
      : {}),
    ...(Array.isArray(value.requiredInputModalities)
      ? {
          requiredInputModalities:
            value.requiredInputModalities as AgentRuntimeView['requiredInputModalities'],
        }
      : {}),
    ...(isBuiltinGlobalReviewPolicyMode(value.globalReviewPolicyMode)
      ? { globalReviewPolicyMode: value.globalReviewPolicyMode }
      : {}),
    ...(isAutoAuthorizationSafetyLevel(value.autoAuthorizationSafetyLevel)
      ? { autoAuthorizationSafetyLevel: value.autoAuthorizationSafetyLevel }
      : {}),
    ...(typeof value.cwd === 'string' ? { cwd: value.cwd } : {}),
    ...(typeof value.workspaceId === 'string' ? { workspaceId: value.workspaceId } : {}),
    ...(typeof value.workspaceName === 'string' ? { workspaceName: value.workspaceName } : {}),
    ...(typeof value.workspaceRoot === 'string' ? { workspaceRoot: value.workspaceRoot } : {}),
    ...(typeof value.stateRoot === 'string' ? { stateRoot: value.stateRoot } : {}),
    ...(typeof value.contextWindow === 'number' ? { contextWindow: value.contextWindow } : {}),
    ...(typeof value.contextCompactionWatermarkTokens === 'number'
      ? { contextCompactionWatermarkTokens: value.contextCompactionWatermarkTokens }
      : {}),
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

function parseAgentRun(
  value: unknown,
  readReviews: ReviewSpecsReader,
  allowLegacyPending: boolean,
): {
    activeRun: AgentRunView | null;
    pendingInterrupt: PendingInterruptProjection | null;
  } | null {
  if (
    !isRecord(value)
    || !isOptionalFiniteNumber(value.startedAt)
    || !isOptionalFiniteNumber(value.updatedAt)
  ) {
    return null;
  }
  const base = {
    ...(typeof value.requestId === 'string' ? { requestId: value.requestId } : {}),
    ...(isFiniteNumber(value.startedAt) ? { startedAt: value.startedAt } : {}),
    ...(isFiniteNumber(value.updatedAt) ? { updatedAt: value.updatedAt } : {}),
  };
  if (value.state === 'running') {
    if (
      typeof value.requestId !== 'string'
      || !isRunActivity(value.activity)
      || value.pendingInterrupt !== undefined
      || value.reviewAction !== undefined
    ) return null;
    return {
      activeRun: {
        ...base,
        requestId: value.requestId,
        state: 'running',
        activity: value.activity,
      },
      pendingInterrupt: null,
    };
  }
  if (allowLegacyPending && value.state === 'pending_interrupt') {
    const pendingInterrupt = parsePendingInterrupt(value.pendingInterrupt, readReviews);
    if (!pendingInterrupt || value.activity !== undefined) return null;
    return { activeRun: null, pendingInterrupt };
  }
  // Snapshot compatibility: pre-PendingInterrupt projections used
  // waiting_review + ReviewAction. Normalize them at the parser boundary.
  if (allowLegacyPending && value.state === 'waiting_review') {
    const pendingInterrupt = parseLegacyReviewAction(value.reviewAction, readReviews);
    if (!pendingInterrupt || value.activity !== undefined) return null;
    return { activeRun: null, pendingInterrupt };
  }
  if (value.state === 'interrupting') {
    if (
      typeof value.requestId !== 'string'
      || value.activity !== undefined
      || value.pendingInterrupt !== undefined
      || value.reviewAction !== undefined
    ) return null;
    return {
      activeRun: {
        ...base,
        requestId: value.requestId,
        state: 'interrupting',
      },
      pendingInterrupt: null,
    };
  }
  return null;
}

function parsePendingInterrupt(
  value: unknown,
  readReviews: ReviewSpecsReader,
): PendingInterruptProjection | null {
  if (!isRecord(value)) return null;
  const payload = value.payload;
  if (!isRecord(payload)) return null;
  if (payload.kind === 'pause_task') {
    return Object.keys(value).every((key) => key === 'payload')
      && Object.keys(payload).every((key) => key === 'kind')
      ? { payload: { kind: 'pause_task' } }
      : null;
  }
  if (payload.kind !== 'human_review') return null;
  const interactions = readReviews(payload.interactions);
  if (typeof value.interruptId !== 'string' || !interactions) {
    return null;
  }
  return {
    interruptId: value.interruptId,
    payload: {
      kind: 'human_review',
      interactions,
    },
  };
}

function parseLegacyReviewAction(
  value: unknown,
  readReviews: ReviewSpecsReader,
): PendingInterruptProjection | null {
  if (!isRecord(value)) return null;
  const interactions = readReviews(value.reviews);
  if (typeof value.actionId !== 'string' || !interactions) return null;
  return {
    interruptId: value.actionId,
    payload: {
      kind: 'human_review',
      interactions,
    },
  };
}

function readReviewSpecs(value: unknown): HumanReviewRequest[] | null {
  if (!Array.isArray(value)) return null;
  const reviews = value.flatMap((item) => {
    const review = parseHumanReviewRequest(item);
    return review ? [review] : [];
  });
  return reviews.length === value.length && reviews.length > 0 ? reviews : null;
}

function readLegacyReviewSpecs(value: unknown): HumanReviewRequest[] | null {
  if (!Array.isArray(value)) return null;
  const reviews = value.flatMap((item) => {
    const review = parseHumanReviewRequest(item) ?? projectLegacyReviewSpec(item);
    return review ? [review] : [];
  });
  return reviews.length === value.length && reviews.length > 0 ? reviews : null;
}

function projectLegacyReviewSpec(value: unknown): HumanReviewRequest | null {
  if (
    !isRecord(value)
    || typeof value.id !== 'string'
    || typeof value.schemaVersion !== 'number'
    || !Number.isFinite(value.schemaVersion)
    || !Array.isArray(value.options)
    || !isJsonValue(value)
  ) {
    return null;
  }
  const options = value.options.map(projectLegacyReviewOption);
  if (options.some((option) => option === null)) return null;
  return parseHumanReviewRequest({
    interactionId: value.id,
    schemaVersion: HUMAN_REVIEW_REQUEST_SCHEMA_VERSION,
    view: value.view,
    options,
  });
}

function projectLegacyReviewOption(value: unknown) {
  if (!isRecord(value) || !isRecord(value.decision)) return null;
  if (
    value.decision.type !== 'approve'
    && value.decision.type !== 'reject'
    && value.decision.type !== 'respond'
  ) {
    return null;
  }
  return {
    id: value.id,
    label: value.label,
    ...(value.description !== undefined ? { description: value.description } : {}),
    ...(value.variant !== undefined ? { variant: value.variant } : {}),
    ...(value.input !== undefined ? { input: value.input } : {}),
    batchSubmission: value.decision.type === 'approve' ? 'defer' : 'immediate',
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isSessionKind(value: unknown): value is AgentSession['kind'] {
  return value === 'chat';
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
