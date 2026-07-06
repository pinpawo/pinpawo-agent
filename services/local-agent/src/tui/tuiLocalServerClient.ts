import { randomUUID } from 'node:crypto';
import { isTokenUsageSnapshot, type ReviewSpec } from '@pinpawo/pet-agent';
import {
  buildLocalServerAuthHeaders,
  readLocalServerAuthToken,
} from '../localServerAuth';
import type { MessageCellModel } from './state/tuiState';
import type {
  TuiCoreOperationTimelineEntry,
  TuiCoreRunSnapshot,
  TuiCoreSessionSnapshot,
  TuiCoreTimelineEntry,
} from './contracts/tuiCoreContract';
import { buildTuiSessionSnapshotFromMessages } from './snapshot/tuiSessionSnapshot';
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

export type LocalServerRuntimeSnapshot = {
  model?: string;
  contextWindow?: number;
  cwd?: string;
  stateRoot?: string;
  studioConfigPath?: string;
  studioDueRunsPath?: string;
  studioConfigSource?: string;
  studioConfigActivePath?: string;
  legacyStudioConfigPath?: string;
  petsDir?: string;
  studioWikiBaseDir?: string;
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

  async readHistory(): Promise<MessageCellModel[]> {
    const res = await this.fetchAuth(this.url('/history'));
    if (!res.ok) {
      throw new LocalServerHttpError(res.status);
    }
    const payload = await res.json() as {
      messages?: Array<{ role?: string; text?: string }>;
    };
    return parseHistoryMessages(payload.messages);
  }

  async readSessionSnapshot(params: {
    sessionId: string;
    kind: TuiCoreSessionSnapshot['kind'];
  }): Promise<TuiCoreSessionSnapshot> {
    const [serverSnapshot, runtime] = await Promise.all([
      this.readServerSnapshot().catch((err) => {
        if (err instanceof LocalServerHttpError && err.status === 404) {
          return null;
        }
        throw err;
      }),
      this.readRuntime().catch(() => null),
    ]);
    if (serverSnapshot) {
      const nativeSnapshot = parseTuiCoreSessionSnapshot(serverSnapshot);
      if (nativeSnapshot) {
        return mergeSnapshotRuntime(nativeSnapshot, runtime);
      }
      const legacySnapshot = buildSessionSnapshotFromServerPayload(serverSnapshot as LocalServerSnapshotPayload, {
        fallbackSessionId: params.sessionId,
        fallbackKind: params.kind,
        runtime,
      });
      if (legacySnapshot) {
        return legacySnapshot;
      }
      throw new Error('invalid local server snapshot payload');
    }
    const messages = await this.readHistory();
    return buildTuiSessionSnapshotFromMessages({
      sessionId: params.sessionId,
      kind: params.kind,
      messages,
      runtime,
    });
  }

  private async readServerSnapshot(): Promise<unknown> {
    const res = await this.fetchAuth(this.url('/snapshot'));
    if (!res.ok) {
      throw new LocalServerHttpError(res.status);
    }
    return await res.json() as LocalServerSnapshotPayload;
  }

  async readRuntime(timeoutMs = DEFAULT_HEALTH_TIMEOUT_MS): Promise<LocalServerRuntimeSnapshot | null> {
    try {
      const res = await this.fetchWithTimeout(this.url('/runtime'), timeoutMs);
      if (!res.ok) return null;
      return parseLocalServerRuntime(await res.json());
    } catch {
      return null;
    }
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
    snapshot: TuiCoreSessionSnapshot;
  }> {
    const res = await this.fetchAuth(
      this.url(`/sessions/resume?sessionId=${encodeURIComponent(sessionId)}`),
    );
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }
    const payload = await res.json() as {
      session?: unknown;
      messages?: Array<{ role?: string; text?: string }>;
      snapshot?: unknown;
    };
    const session = parseResumeSessionSummary(payload.session);
    if (!session) {
      throw new Error('invalid resume session payload');
    }
    const messages = parseHistoryMessages(payload.messages);
    const nativeSnapshot = parseTuiCoreSessionSnapshot(payload.snapshot);
    return {
      session,
      snapshot: nativeSnapshot ?? buildTuiSessionSnapshotFromMessages({
        sessionId: session.id,
        kind: session.kind ?? parseSnapshotSession(payload.session)?.kind ?? 'chat',
        messages,
      }),
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

type LocalServerSnapshotPayload = {
  session?: unknown;
  messages?: Array<{ role?: string; text?: string }>;
  pendingReview?: unknown;
};

type ParsedSnapshotSession = {
  id: string;
  kind?: TuiCoreSessionSnapshot['kind'];
};

type ParsedPendingReview = {
  requestId: string;
  interruptId?: string;
  reviewId: string;
  sessionId?: string;
  review: ReviewSpec;
  reviews?: ReviewSpec[];
  petId?: string;
};

function buildSessionSnapshotFromServerPayload(
  payload: LocalServerSnapshotPayload,
  options: {
    fallbackSessionId: string;
    fallbackKind: TuiCoreSessionSnapshot['kind'];
    runtime?: LocalServerRuntimeSnapshot | null;
  },
): TuiCoreSessionSnapshot | null {
  const session = parseSnapshotSession(payload.session);
  const sessionId = session?.id ?? options.fallbackSessionId;
  const kind = session?.kind ?? options.fallbackKind;
  const pendingReview = parsePendingReviewSnapshot(payload.pendingReview);
  if (!Array.isArray(payload.messages) && !pendingReview) {
    return null;
  }
  const messages = parseHistoryMessages(payload.messages);
  const snapshot = buildTuiSessionSnapshotFromMessages({
    sessionId,
    kind,
    messages,
    runtime: options.runtime,
  });
  if (!pendingReview) {
    return snapshot;
  }
  return {
    ...snapshot,
    runs: [{
      requestId: pendingReview.requestId,
      sessionId: pendingReview.sessionId ?? sessionId,
      kind,
      phase: 'waiting_human',
      timelineEntryIds: snapshot.timeline.map((entry) => entry.id),
      pendingReview: {
        requestId: pendingReview.requestId,
        ...(pendingReview.interruptId ? { interruptId: pendingReview.interruptId } : {}),
        reviewId: pendingReview.reviewId,
        status: 'waiting',
        review: pendingReview.review,
        ...(pendingReview.reviews ? { reviews: pendingReview.reviews } : {}),
        ...(pendingReview.petId ? { petId: pendingReview.petId } : {}),
      },
    }],
    activeRunId: pendingReview.requestId,
    pendingReviewId: pendingReview.reviewId,
  };
}

function mergeSnapshotRuntime(
  snapshot: TuiCoreSessionSnapshot,
  runtime: LocalServerRuntimeSnapshot | null,
): TuiCoreSessionSnapshot {
  if (!runtime) return snapshot;
  return {
    ...snapshot,
    runtime: {
      ...runtime,
      ...(snapshot.runtime ?? {}),
    },
  };
}

function parseTuiCoreSessionSnapshot(value: unknown): TuiCoreSessionSnapshot | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (
    typeof record.sessionId !== 'string'
    || !isSessionKind(record.kind)
    || !Array.isArray(record.timeline)
    || !Array.isArray(record.runs)
  ) {
    return null;
  }
  const timeline = record.timeline.flatMap((entry) => {
    const parsed = parseTuiCoreTimelineEntry(entry);
    return parsed ? [parsed] : [];
  });
  const runs = record.runs.flatMap((run) => {
    const parsed = parseTuiCoreRunSnapshot(run);
    return parsed ? [parsed] : [];
  });
  if (timeline.length !== record.timeline.length || runs.length !== record.runs.length) {
    return null;
  }
  return {
    sessionId: record.sessionId,
    kind: record.kind,
    timeline,
    runs,
    ...(typeof record.activeRunId === 'string' ? { activeRunId: record.activeRunId } : {}),
    ...(typeof record.pendingReviewId === 'string' ? { pendingReviewId: record.pendingReviewId } : {}),
    ...(isRecord(record.runtime) ? { runtime: record.runtime as TuiCoreSessionSnapshot['runtime'] } : {}),
    ...(isTokenUsageSnapshot(record.tokenUsage) ? { tokenUsage: record.tokenUsage } : {}),
  };
}

function parseTuiCoreTimelineEntry(value: unknown): TuiCoreTimelineEntry | null {
  if (!isRecord(value) || typeof value.id !== 'string' || !isTimelineSource(value.source)) {
    return null;
  }
  if (value.type === 'message') {
    if (
      (value.role !== 'user' && value.role !== 'assistant')
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
      source: value.source,
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
    ) {
      return null;
    }
    return {
      id: value.id,
      type: 'operation',
      requestId: value.requestId,
      operationKey: value.operationKey,
      phase: value.phase,
      source: value.source,
      ...(typeof value.title === 'string' ? { title: value.title } : {}),
      ...(typeof value.summary === 'string' ? { summary: value.summary } : {}),
      ...(typeof value.startedAt === 'number' ? { startedAt: value.startedAt } : {}),
      ...(typeof value.updatedAt === 'number' ? { updatedAt: value.updatedAt } : {}),
      ...(typeof value.completedAt === 'number' ? { completedAt: value.completedAt } : {}),
    } satisfies TuiCoreOperationTimelineEntry;
  }
  return null;
}

function parseTuiCoreRunSnapshot(value: unknown): TuiCoreRunSnapshot | null {
  if (
    !isRecord(value)
    || typeof value.requestId !== 'string'
    || typeof value.sessionId !== 'string'
    || !isSessionKind(value.kind)
    || !isRunPhase(value.phase)
    || !Array.isArray(value.timelineEntryIds)
    || !value.timelineEntryIds.every((item) => typeof item === 'string')
  ) {
    return null;
  }
  const pendingReviewReviews = isRecord(value.pendingReview)
    ? readReviewSpecs(value.pendingReview.reviews)
    : null;
  const pendingReview = isRecord(value.pendingReview) && typeof value.pendingReview.requestId === 'string'
    && typeof value.pendingReview.reviewId === 'string'
    && isPendingReviewStatus(value.pendingReview.status)
    ? {
        requestId: value.pendingReview.requestId,
        ...(typeof value.pendingReview.interruptId === 'string' ? { interruptId: value.pendingReview.interruptId } : {}),
        reviewId: value.pendingReview.reviewId,
        status: value.pendingReview.status,
        ...(isRecord(value.pendingReview.review) ? { review: value.pendingReview.review as ReviewSpec } : {}),
        ...(pendingReviewReviews ? { reviews: pendingReviewReviews } : {}),
        ...(typeof value.pendingReview.petId === 'string' ? { petId: value.pendingReview.petId } : {}),
      }
    : undefined;
  return {
    requestId: value.requestId,
    sessionId: value.sessionId,
    kind: value.kind,
    phase: value.phase,
    timelineEntryIds: value.timelineEntryIds,
    ...(pendingReview ? { pendingReview } : {}),
    ...(typeof value.startedAt === 'number' ? { startedAt: value.startedAt } : {}),
    ...(typeof value.updatedAt === 'number' ? { updatedAt: value.updatedAt } : {}),
    ...(typeof value.finishedAt === 'number' ? { finishedAt: value.finishedAt } : {}),
  };
}

function parseSnapshotSession(value: unknown): ParsedSnapshotSession | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (typeof record.id !== 'string') return null;
  const kind = record.kind === 'chat' || record.kind === 'studio'
    ? record.kind
    : undefined;
  return {
    id: record.id,
    ...(kind ? { kind } : {}),
  };
}

function parsePendingReviewSnapshot(value: unknown): ParsedPendingReview | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const review = record.review;
  if (
    typeof record.requestId !== 'string'
    || typeof record.reviewId !== 'string'
    || !review
    || typeof review !== 'object'
    || Array.isArray(review)
    || typeof (review as Record<string, unknown>).id !== 'string'
  ) {
    return null;
  }
  const reviews = readReviewSpecs(record.reviews);
  return {
    requestId: record.requestId,
    ...(typeof record.interruptId === 'string' ? { interruptId: record.interruptId } : {}),
    reviewId: record.reviewId,
    ...(typeof record.sessionId === 'string' ? { sessionId: record.sessionId } : {}),
    review: review as ReviewSpec,
    ...(reviews ? { reviews } : {}),
    ...(readPendingReviewPetId(record) ? { petId: readPendingReviewPetId(record) } : {}),
  };
}

function readReviewSpecs(value: unknown): ReviewSpec[] | null {
  if (!Array.isArray(value)) return null;
  const reviews = value.filter((item): item is ReviewSpec =>
    Boolean(item && typeof item === 'object' && !Array.isArray(item)
      && typeof (item as Record<string, unknown>).id === 'string'));
  return reviews.length === value.length && reviews.length > 0 ? reviews : null;
}

function readPendingReviewPetId(record: Record<string, unknown>) {
  if (typeof record.petId === 'string') return record.petId;
  const actor = record.actor;
  if (!actor || typeof actor !== 'object' || Array.isArray(actor)) return undefined;
  const petId = (actor as Record<string, unknown>).petId;
  return typeof petId === 'string' ? petId : undefined;
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

export function parseHistoryMessages(
  messages: Array<{ role?: string; text?: string }> | undefined,
): MessageCellModel[] {
  return Array.isArray(messages)
    ? messages.flatMap((item) => {
        if (
          (item.role === 'user' || item.role === 'assistant' || item.role === 'system')
          && typeof item.text === 'string'
          && item.text.trim()
        ) {
          return [{
            id: randomUUID(),
            kind: item.role,
            text: item.text,
          } satisfies MessageCellModel];
        }
        return [];
      })
    : [];
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

function parsePositiveInteger(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) {
    return value;
  }

  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
  }

  return undefined;
}

function pickString(record: Record<string, unknown>, keys: string[]) {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }
  }
  return undefined;
}

export function parseLocalServerRuntime(payload: unknown): LocalServerRuntimeSnapshot | null {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  const record = payload as Record<string, unknown>;
  const llmConfig = record.llmConfig;
  const nested =
    typeof llmConfig === 'object' && llmConfig !== null && !Array.isArray(llmConfig)
      ? llmConfig as Record<string, unknown>
      : null;
  const rawModel = pickString(record, ['llm_model', 'llmModel', 'model']);
  const rawWorkdir = pickString(record, ['workdir', 'workDir', 'cwd', 'work_dir']);
  const rawStateRoot = pickString(record, ['state_root', 'stateRoot']);
  const rawStudioConfigPath = pickString(record, ['studio_config_path', 'studioConfigPath']);
  const rawStudioDueRunsPath = pickString(record, ['studio_due_runs_path', 'studioDueRunsPath']);
  const rawStudioConfigSource = pickString(record, ['studio_config_source', 'studioConfigSource']);
  const rawStudioConfigActivePath = pickString(record, ['studio_config_active_path', 'studioConfigActivePath']);
  const rawLegacyStudioConfigPath = pickString(record, ['legacy_studio_config_path', 'legacyStudioConfigPath']);
  const rawPetsDir = pickString(record, ['pets_dir', 'petsDir']);
  const rawStudioWikiBaseDir = pickString(record, ['studio_wiki_base_dir', 'studioWikiBaseDir']);
  const rawContextWindow =
    pickString(record, ['llm_context_window_tokens', 'llmContextWindowTokens', 'contextWindow', 'context_window_tokens'])
    ?? record.llm_context_window_tokens
    ?? record.llmContextWindowTokens
    ?? record.contextWindow
    ?? record.context_window_tokens;
  const nestedContextWindow = nested
    ? (parsePositiveInteger(nested.contextWindow)
      ?? parsePositiveInteger(nested.context_window_tokens)
      ?? parsePositiveInteger(nested.context_window))
    : undefined;
  const nestedModel = nested ? pickString(nested, ['model', 'llmModel']) : undefined;

  return {
    model: rawModel ?? nestedModel,
    contextWindow: parsePositiveInteger(rawContextWindow) ?? nestedContextWindow,
    cwd: rawWorkdir ?? pickString(nested ?? {}, ['workdir', 'cwd']),
    stateRoot: rawStateRoot,
    studioConfigPath: rawStudioConfigPath,
    studioDueRunsPath: rawStudioDueRunsPath,
    studioConfigSource: rawStudioConfigSource,
    studioConfigActivePath: rawStudioConfigActivePath,
    legacyStudioConfigPath: rawLegacyStudioConfigPath,
    petsDir: rawPetsDir,
    studioWikiBaseDir: rawStudioWikiBaseDir,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isSessionKind(value: unknown): value is TuiCoreSessionSnapshot['kind'] {
  return value === 'chat' || value === 'studio';
}

function isTimelineSource(value: unknown): value is TuiCoreTimelineEntry['source'] {
  return value === 'checkpoint' || value === 'live-event' || value === 'local-input';
}

function isOperationPhase(value: unknown): value is TuiCoreOperationTimelineEntry['phase'] {
  return value === 'started'
    || value === 'updated'
    || value === 'completed'
    || value === 'failed'
    || value === 'interrupted';
}

function isRunPhase(value: unknown): value is TuiCoreRunSnapshot['phase'] {
  return value === 'starting'
    || value === 'thinking'
    || value === 'using_tool'
    || value === 'streaming'
    || value === 'waiting_human'
    || value === 'interrupting'
    || value === 'completed'
    || value === 'failed'
    || value === 'interrupted';
}

function isPendingReviewStatus(value: unknown): value is NonNullable<TuiCoreRunSnapshot['pendingReview']>['status'] {
  return value === 'waiting' || value === 'answered' || value === 'interrupted';
}
