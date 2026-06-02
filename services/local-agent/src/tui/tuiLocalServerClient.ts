import { randomUUID } from 'node:crypto';
import type { HistoryCellModel } from './state/tuiState';
import type { ResumeSessionSummary } from './types';

const DEFAULT_HEALTH_TIMEOUT_MS = 1500;

type FetchLike = typeof fetch;

type TuiLocalServerClientOptions = {
  port: number;
  fetchImpl?: FetchLike;
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
