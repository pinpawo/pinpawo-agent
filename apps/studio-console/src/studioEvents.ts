import type { LiveEvent } from './dispatchActivity';

export class EventStreamError extends Error {
  constructor(message: string, readonly retryable = true, readonly status?: number) { super(message); }
}

function waitForRetry(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const finish = () => { clearTimeout(timer); signal.removeEventListener('abort', finish); resolve(); };
    const timer = setTimeout(finish, ms);
    signal.addEventListener('abort', finish, { once: true });
  });
}

type EventStreamOptions<T> = {
  url: string;
  headers: Record<string, string>;
  signal: AbortSignal;
  onConnected: () => void;
  onDisconnected: (error: Error, retrying: boolean) => void;
  onEvent: (event: T) => void;
  fetch?: typeof fetch;
  wait?: (ms: number, signal: AbortSignal) => Promise<void>;
};

function readStudioEvent(event: unknown): LiveEvent {
  if (!event || typeof event !== 'object' || !('type' in event) || typeof event.type !== 'string'
    || !('source' in event) || typeof event.source !== 'string'
    || !('occurredAt' in event) || typeof event.occurredAt !== 'string') {
    throw new EventStreamError('Invalid Studio event.');
  }
  return event as LiveEvent;
}

/** Observe live facts. Reconnection restores observation, not missed history. */
export function observeStudioEvents(options: EventStreamOptions<LiveEvent>): Promise<void> {
  return observeEventStream(options, readStudioEvent);
}

/**
 * Read one authenticated SSE stream, reconnecting with backoff. A 4xx other
 * than a throttle is final: the server named something wrong with the request.
 */
export async function observeEventStream<T>(options: EventStreamOptions<T>, read: (data: unknown) => T): Promise<void> {
  const request = options.fetch ?? fetch;
  const wait = options.wait ?? waitForRetry;
  let retryMs = 3_000;
  let failures = 0;
  while (!options.signal.aborted) {
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
    let heartbeatError: Error | undefined;
    let heartbeatPending = false;
    const connectionAbort = new AbortController();
    const abortConnection = () => { connectionAbort.abort(); void reader?.cancel().catch(() => undefined); };
    options.signal.addEventListener('abort', abortConnection, { once: true });
    try {
      const streamUrl = new URL(options.url);
      streamUrl.searchParams.set('heartbeat', '1');
      const response = await request(streamUrl.toString(), { headers: options.headers, signal: connectionAbort.signal });
      if (!response.ok || !response.body) {
        const detail = await response.json().catch(() => null) as { error?: unknown } | null;
        const reason = typeof detail?.error === 'string' ? ` ${detail.error}` : '';
        throw new EventStreamError(`SSE failed (${response.status}).${reason}`, ![400, 401, 403, 404, 426].includes(response.status), response.status);
      }
      if (options.signal.aborted) { await response.body.cancel(); return; }
      reader = response.body.getReader();
      const streamId = response.headers.get('X-Studio-Stream-Id');
      if (streamId) {
        const heartbeatUrl = new URL(options.url);
        heartbeatUrl.pathname = heartbeatUrl.pathname.replace(/\/(?:pet-sessions\/)?events$/, '/me');
        heartbeatUrl.search = '';
        heartbeatUrl.searchParams.set('streamId', streamId);
        const heartbeat = async () => {
          if (heartbeatPending || connectionAbort.signal.aborted) return;
          heartbeatPending = true;
          try {
            const result = await request(heartbeatUrl.toString(), {
              headers: options.headers, signal: AbortSignal.any([connectionAbort.signal, AbortSignal.timeout(5_000)]), cache: 'no-store',
            });
            await result.body?.cancel();
            if (!result.ok) throw new EventStreamError(`SSE heartbeat failed (${result.status}).`, ![400, 401, 403, 404, 426].includes(result.status), result.status);
          } catch (error) {
            if (connectionAbort.signal.aborted) return;
            heartbeatError = error instanceof Error ? error : new Error(String(error));
            abortConnection();
          } finally { heartbeatPending = false; }
        };
        // First prove that /me reaches this connection's Host. Later requests
        // originate here every 10 seconds; SSE comments are only keepalives.
        await heartbeat();
        if (options.signal.aborted) return;
        if (heartbeatError) throw heartbeatError;
        heartbeatTimer = setInterval(() => { void heartbeat(); }, 10_000);
      }
      const decoder = new TextDecoder();
      let pending = '';
      options.onConnected();
      while (!options.signal.aborted) {
        const chunk = await reader.read();
        if (options.signal.aborted) return;
        if (heartbeatError) throw heartbeatError;
        if (chunk.done) throw new EventStreamError('SSE connection closed.');
        pending += decoder.decode(chunk.value, { stream: true });
        let boundary = /\r?\n\r?\n/.exec(pending);
        while (boundary) {
          const block = pending.slice(0, boundary.index);
          pending = pending.slice(boundary.index + boundary[0].length);
          const lines = block.split(/\r?\n/);
          const retry = lines.find((line) => /^retry: *\d+$/.test(line));
          if (retry) retryMs = Math.min(30_000, Math.max(1_000, Number(retry.slice(6).trim())));
          const data = lines.filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trimStart()).join('\n');
          if (data) {
            options.onEvent(read(JSON.parse(data)));
            failures = 0;
          }
          boundary = /\r?\n\r?\n/.exec(pending);
        }
      }
    } catch (error) {
      if (options.signal.aborted) return;
      // Aborting a fetch-backed body rejects reader.read() with AbortError.
      // Preserve the heartbeat's actual authorization failure and retry policy.
      const failure = heartbeatError ?? (error instanceof Error ? error : new Error(String(error)));
      const retrying = !(failure instanceof EventStreamError) || failure.retryable;
      options.onDisconnected(failure, retrying);
      if (!retrying) return;
    } finally {
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      connectionAbort.abort();
      options.signal.removeEventListener('abort', abortConnection);
      await reader?.cancel().catch(() => undefined);
      reader?.releaseLock();
    }
    if (!options.signal.aborted) await wait(Math.min(30_000, retryMs * 2 ** Math.min(failures++, 4)), options.signal);
  }
}
