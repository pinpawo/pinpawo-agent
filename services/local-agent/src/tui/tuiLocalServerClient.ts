import { randomUUID } from 'node:crypto';
import type { HistoryCellModel } from './state/tuiState';
import type { ResumeSessionSummary } from './types';

const DEFAULT_HEALTH_TIMEOUT_MS = 1500;

type FetchLike = typeof fetch;

type TuiLocalServerClientOptions = {
  port: number;
  fetchImpl?: FetchLike;
};

export type LocalServerRuntimeSnapshot = {
  model?: string;
  contextWindow?: number;
  cwd?: string;
};

export class TuiLocalServerClient {
  private readonly fetchImpl: FetchLike;

  constructor(private readonly options: TuiLocalServerClientOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
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
    const res = await this.fetchImpl(this.url('/history'));
    if (!res.ok) return [];
    const payload = await res.json() as {
      messages?: Array<{ role?: string; text?: string }>;
    };
    return parseHistoryMessages(payload.messages);
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
    const res = await this.fetchImpl(this.url('/sessions'));
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
  }> {
    const res = await this.fetchImpl(
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
    return {
      session,
      history: parseHistoryMessages(payload.messages),
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
      return await this.fetchImpl(url, { signal: controller.signal });
    } finally {
      clearTimeout(timeout);
    }
  }
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
  };
}
