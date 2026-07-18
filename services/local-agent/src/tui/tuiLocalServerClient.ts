import { isTokenUsageSnapshot, type ReviewSpec } from '@pinpawo/pet-agent';
import {
  buildLocalServerAuthHeaders,
  readLocalServerAuthToken,
} from '../localServerAuth';
import type {
  LocalAgentOperationEntry,
  LocalAgentReviewAction,
  LocalAgentRunActivity,
  LocalAgentRunView,
  LocalAgentRuntimeView,
  LocalAgentSession,
  LocalAgentSessionSnapshot,
  LocalAgentTimelineEntry,
} from '../localAgentSession';
import { LOCAL_AGENT_SESSION_SNAPSHOT_VERSION } from '../localAgentSession';
import type { ResumeSessionSummary } from './types';

const DEFAULT_HEALTH_TIMEOUT_MS = 1500;

type FetchLike = typeof fetch;

class LocalServerHttpError extends Error {
  constructor(readonly status: number) {
    super(`HTTP ${status}`);
  }
}

type TuiLocalServerClientOptions = {
  port: number;
  fetchImpl?: FetchLike;
  tokenProvider?: () => string | null;
};

export class TuiLocalServerClient {
  private readonly fetchImpl: FetchLike;
  private readonly tokenProvider: () => string | null;

  constructor(private readonly options: TuiLocalServerClientOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.tokenProvider = options.tokenProvider ?? (() => readLocalServerAuthToken());
  }

  async isHealthy(timeoutMs = DEFAULT_HEALTH_TIMEOUT_MS) {
    try {
      const res = await this.fetchWithTimeout(this.url('/health'), timeoutMs);
      return res.ok;
    } catch {
      return false;
    }
  }

  async readSessionSnapshot(): Promise<LocalAgentSessionSnapshot> {
    const res = await this.fetchAuth(this.url('/snapshot'));
    if (!res.ok) throw new LocalServerHttpError(res.status);
    const serverSnapshot = await res.json() as unknown;
    const snapshot = parseLocalAgentSessionSnapshot(serverSnapshot);
    if (!snapshot) throw new Error('invalid local server snapshot payload');
    return snapshot;
  }

  async listResumeSessions(): Promise<ResumeSessionSummary[]> {
    const res = await this.fetchAuth(this.url('/sessions'));
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }
    const payload = await res.json() as { sessions?: unknown };
    return Array.isArray(payload.sessions)
      ? payload.sessions.flatMap((item) => {
          const session = parseResumeSessionSummary(item);
          return session ? [session] : [];
        })
      : [];
  }

  async resumeSession(sessionId: string): Promise<{
    session: ResumeSessionSummary;
    snapshot: LocalAgentSessionSnapshot;
  }> {
    const res = await this.fetchAuth(
      this.url(`/sessions/resume?sessionId=${encodeURIComponent(sessionId)}`),
    );
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }
    const payload = await res.json() as {
      session?: unknown;
      snapshot?: unknown;
    };
    const session = parseResumeSessionSummary(payload.session);
    if (!session) {
      throw new Error('invalid resume session payload');
    }
    const snapshot = parseLocalAgentSessionSnapshot(payload.snapshot);
    if (
      !snapshot
      || snapshot.session.sessionId !== session.id
      || (session.kind !== undefined && snapshot.session.kind !== session.kind)
    ) {
      throw new Error('invalid resume session snapshot');
    }
    return {
      session,
      snapshot,
    };
  }

  private url(path: string) {
    return `http://127.0.0.1:${this.options.port}${path}`;
  }

  private async fetchWithTimeout(url: string, timeoutMs: number) {
    const controller = new AbortController();
    const timeout = setTimeout(() => {
      controller.abort();
    }, timeoutMs);
    try {
      return await this.fetchAuth(url, { signal: controller.signal });
    } finally {
      clearTimeout(timeout);
    }
  }

  private fetchAuth(url: string, init: RequestInit = {}) {
    return this.fetchImpl(url, {
      ...init,
      headers: {
        ...buildLocalServerAuthHeaders(this.tokenProvider()),
        ...normalizeHeaders(init.headers),
      },
    });
  }
}

function parseLocalAgentSessionSnapshot(value: unknown): LocalAgentSessionSnapshot | null {
  if (!isRecord(value)) return null;
  if (value.version !== LOCAL_AGENT_SESSION_SNAPSHOT_VERSION) return null;
  const session = parseLocalAgentSession(value.session);
  return session
    ? { version: LOCAL_AGENT_SESSION_SNAPSHOT_VERSION, session }
    : null;
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
  return {
    sessionId: value.sessionId,
    kind: value.kind,
    timeline,
    activeRun,
    ...(actor ? { actor } : {}),
    ...(runtime ? { runtime } : {}),
    ...(isTokenUsageSnapshot(value.tokenUsage) ? { tokenUsage: value.tokenUsage } : {}),
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
    'studioConfigActivePath',
    'legacyStudioConfigPath',
    'petsDir',
    'studioWikiBaseDir',
  ] as const;
  if (stringFields.some((field) =>
    value[field] !== undefined && typeof value[field] !== 'string')) {
    return null;
  }
  if (
    value.studioConfigSource !== undefined
    && value.studioConfigSource !== 'workdir'
    && value.studioConfigSource !== 'legacy_home'
    && value.studioConfigSource !== 'missing'
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
  return {
    ...(typeof value.model === 'string' ? { model: value.model } : {}),
    ...(typeof value.cwd === 'string' ? { cwd: value.cwd } : {}),
    ...(typeof value.workspaceId === 'string' ? { workspaceId: value.workspaceId } : {}),
    ...(typeof value.workspaceName === 'string' ? { workspaceName: value.workspaceName } : {}),
    ...(typeof value.workspaceRoot === 'string' ? { workspaceRoot: value.workspaceRoot } : {}),
    ...(typeof value.stateRoot === 'string' ? { stateRoot: value.stateRoot } : {}),
    ...(typeof value.studioConfigPath === 'string' ? { studioConfigPath: value.studioConfigPath } : {}),
    ...(typeof value.studioDueRunsPath === 'string' ? { studioDueRunsPath: value.studioDueRunsPath } : {}),
    ...(typeof value.studioConfigSource === 'string' ? { studioConfigSource: value.studioConfigSource } : {}),
    ...(typeof value.studioConfigActivePath === 'string' ? { studioConfigActivePath: value.studioConfigActivePath } : {}),
    ...(typeof value.legacyStudioConfigPath === 'string' ? { legacyStudioConfigPath: value.legacyStudioConfigPath } : {}),
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

function normalizeHeaders(headers: RequestInit['headers']): Record<string, string> {
  if (!headers) return {};
  if (headers instanceof Headers) {
    return Object.fromEntries(headers.entries());
  }
  if (Array.isArray(headers)) {
    return Object.fromEntries(headers);
  }
  return headers as Record<string, string>;
}

export function parseResumeSessionSummary(value: unknown): ResumeSessionSummary | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (
    typeof record.id !== 'string'
    || typeof record.title !== 'string'
    || typeof record.createdAt !== 'string'
    || typeof record.updatedAt !== 'string'
  ) {
    return null;
  }
  return {
    id: record.id,
    ...(isSessionKind(record.kind) ? { kind: record.kind } : {}),
    title: record.title,
    messageCount: typeof record.messageCount === 'number' ? record.messageCount : 0,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    active: record.active === true,
  };
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
