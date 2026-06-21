import { randomUUID } from 'node:crypto';
import {
  buildLocalServerAuthHeaders,
  readLocalServerAuthToken,
} from '../localServerAuth';
import type { HistoryCellModel } from './state/tuiState';
import type { TuiCoreSessionSnapshot } from './contracts/tuiCoreContract';
import { buildTuiSessionSnapshotFromHistory } from './snapshot/tuiSessionSnapshot';
import type { ResumeSessionSummary } from './types';

const DEFAULT_HEALTH_TIMEOUT_MS = 1500;

type FetchLike = typeof fetch;

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

  async readHistory(): Promise<HistoryCellModel[]> {
    const res = await this.fetchAuth(this.url('/history'));
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
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
    const [history, runtime] = await Promise.all([
      this.readHistory(),
      this.readRuntime().catch(() => null),
    ]);
    return buildTuiSessionSnapshotFromHistory({
      sessionId: params.sessionId,
      kind: params.kind,
      history,
      runtime,
    });
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
    history: HistoryCellModel[];
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
    };
    const session = parseResumeSessionSummary(payload.session);
    if (!session) {
      throw new Error('invalid resume session payload');
    }
    const history = parseHistoryMessages(payload.messages);
    return {
      session,
      history,
      snapshot: buildTuiSessionSnapshotFromHistory({
        sessionId: session.id,
        kind: 'chat',
        history,
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
): HistoryCellModel[] {
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
          } satisfies HistoryCellModel];
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
