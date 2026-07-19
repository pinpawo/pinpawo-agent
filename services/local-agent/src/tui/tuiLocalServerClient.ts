import {
  buildLocalServerAuthHeaders,
  readLocalServerAuthToken,
} from '../localServerAuth';
import type { LocalAgentSessionSnapshot } from '../localAgentSession';
import {
  parseLocalAgentSessionSnapshot,
  parseLocalAgentSessionSummary,
} from '../localAgentSessionParser';
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
          const session = parseLocalAgentSessionSummary(item);
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
    const session = parseLocalAgentSessionSummary(payload.session);
    if (!session) {
      throw new Error('invalid resume session payload');
    }
    const snapshot = parseLocalAgentSessionSnapshot(payload.snapshot);
    if (
      !snapshot
      || snapshot.session.sessionId !== session.id
      || snapshot.session.kind !== session.kind
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
