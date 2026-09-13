import type { LiveEvent } from './dispatchActivity';

class EventStreamError extends Error {
  constructor(message: string, readonly retryable = true) { super(message); }
}

function waitForRetry(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const finish = () => { clearTimeout(timer); signal.removeEventListener('abort', finish); resolve(); };
    const timer = setTimeout(finish, ms);
    signal.addEventListener('abort', finish, { once: true });
  });
}

/** Observe live facts. Reconnection restores observation, not missed history. */
export async function observeStudioEvents(options: {
  url: string;
  headers: Record<string, string>;
  signal: AbortSignal;
  onConnected: () => void;
  onDisconnected: (error: Error, retrying: boolean) => void;
  onEvent: (event: LiveEvent) => void;
  fetch?: typeof fetch;
  wait?: (ms: number, signal: AbortSignal) => Promise<void>;
}): Promise<void> {
  const request = options.fetch ?? fetch;
  const wait = options.wait ?? waitForRetry;
  let retryMs = 3_000;
  let failures = 0;
  while (!options.signal.aborted) {
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      const response = await request(options.url, { headers: options.headers, signal: options.signal });
      if (!response.ok || !response.body) {
        await response.body?.cancel();
        throw new EventStreamError(`SSE failed (${response.status}).`, ![400, 401, 403, 404].includes(response.status));
      }
      if (options.signal.aborted) { await response.body.cancel(); return; }
      reader = response.body.getReader();
      const decoder = new TextDecoder();
      let pending = '';
      options.onConnected();
      while (!options.signal.aborted) {
        const chunk = await reader.read();
        if (options.signal.aborted) return;
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
            const event: unknown = JSON.parse(data);
            if (!event || typeof event !== 'object' || !('type' in event) || typeof event.type !== 'string'
              || !('source' in event) || typeof event.source !== 'string'
              || !('occurredAt' in event) || typeof event.occurredAt !== 'string') {
              throw new EventStreamError('Invalid Studio event.');
            }
            options.onEvent(event as LiveEvent);
            failures = 0;
          }
          boundary = /\r?\n\r?\n/.exec(pending);
        }
      }
    } catch (error) {
      if (options.signal.aborted) return;
      const retrying = !(error instanceof EventStreamError) || error.retryable;
      options.onDisconnected(error instanceof Error ? error : new Error(String(error)), retrying);
      if (!retrying) return;
    } finally {
      await reader?.cancel().catch(() => undefined);
      reader?.releaseLock();
    }
    if (!options.signal.aborted) await wait(Math.min(30_000, retryMs * 2 ** Math.min(failures++, 4)), options.signal);
  }
}
