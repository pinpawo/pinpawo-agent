import assert from 'node:assert/strict';
import { test } from 'node:test';
import { appendDispatchRecord, dispatchRecordFromEvent, markObservationLost, type DispatchRecord } from '../src/dispatchActivity';
import { observeStudioEvents } from '../src/studioEvents';

function record(state: DispatchRecord['state']): DispatchRecord {
  return { invocationId: 'one', petId: 'wiki', request: 'Check sources', producer: 'resident-pet',
    state, updatedAt: '2026-09-14T00:00:00Z', source: 'lifecycle' };
}

test('a late HTTP receipt does not regress running or completed lifecycle', () => {
  for (const state of ['queued', 'running', 'waiting', 'completed', 'failed'] as const) {
    const receipt = { ...record('queued'), source: 'admission_receipt' as const, producer: 'http' };
    const [merged] = appendDispatchRecord([record(state)], receipt);
    assert.equal(merged?.state, state);
    assert.equal(merged?.source, 'lifecycle');
    assert.equal(merged?.producer, 'http');
  }
});

test('reconnection keeps terminal facts and leaves active observations unknown until new lifecycle', () => {
  const records = markObservationLost([record('running'), { ...record('completed'), invocationId: 'two' }]);
  assert.equal(records[0]?.observationLost, true);
  assert.equal(records[1]?.observationLost, undefined);
  const receipt = { ...record('queued'), producer: 'http', source: 'admission_receipt' as const };
  assert.equal(appendDispatchRecord(records, receipt)[0]?.observationLost, true);
  const event = dispatchRecordFromEvent({ source: 'resident-pet', type: 'dispatch.waiting',
    occurredAt: '2026-09-14T00:01:00Z', payload: record('waiting') });
  assert.ok(event);
  const updated = appendDispatchRecord(records, event);
  assert.equal(updated[0]?.state, 'waiting');
  assert.equal(updated[0]?.observationLost, false);
  assert.equal(updated[1]?.state, 'completed');
});

function stream(chunks: string[]) {
  return new Response(new ReadableStream<Uint8Array>({ start(controller) {
    for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk));
    controller.close();
  } }), { headers: { 'Content-Type': 'text/event-stream' } });
}
const event = { type: 'dispatch.running', source: 'resident-pet', occurredAt: '2026-09-14T00:00:00Z', payload: record('running') };

test('fragmented CRLF and multiline SSE frames arrive before any domain refresh is needed', async () => {
  const abort = new AbortController();
  const order: string[] = [];
  await observeStudioEvents({ url: 'http://host/events', headers: {}, signal: abort.signal,
    fetch: async () => stream(['retry: 3000\r', '\n: connected\r\n\r', '\ndata: {\r\ndata: ', JSON.stringify(event).slice(1), '\r\n\r\n']),
    onConnected: () => { order.push('connected'); },
    onEvent: (received) => { assert.deepEqual(received, event); order.push('running'); abort.abort(); },
    onDisconnected: () => assert.fail('unexpected disconnect'),
  });
  assert.deepEqual(order, ['connected', 'running']);
});

test('a transient disconnect reconnects, honors retry and resumes live observation', async () => {
  const abort = new AbortController();
  const states: string[] = [];
  let requests = 0;
  await observeStudioEvents({ url: 'http://host/events', headers: { Authorization: 'Bearer test-only' }, signal: abort.signal,
    fetch: async (_url, init) => {
      assert.deepEqual(init?.headers, { Authorization: 'Bearer test-only' });
      return ++requests === 1 ? stream(['retry: 1200\n\n']) : stream([`data: ${JSON.stringify(event)}\n\n`]);
    },
    onConnected: () => { states.push('connected'); },
    onDisconnected: (_error, retrying) => { assert.equal(retrying, true); states.push('unknown'); },
    wait: async (ms) => { assert.equal(ms, 1200); },
    onEvent: () => { states.push('running'); abort.abort(); },
  });
  assert.equal(requests, 2);
  assert.deepEqual(states, ['connected', 'unknown', 'connected', 'running']);
});

test('authentication failure stops retry without claiming connected', async () => {
  let failed = false;
  await observeStudioEvents({ url: 'http://host/events', headers: {}, signal: new AbortController().signal,
    fetch: async () => new Response('', { status: 401 }),
    onConnected: () => assert.fail('not authenticated'), onEvent: () => assert.fail('no event'),
    onDisconnected: (_error, retrying) => { assert.equal(retrying, false); failed = true; },
    wait: async () => assert.fail('must not retry invalid credentials'),
  });
  assert.equal(failed, true);
});

test('switching Host while waiting for retry stops the old observation loop', async () => {
  const abort = new AbortController();
  let requests = 0;
  await observeStudioEvents({ url: 'http://old-host/events', headers: {}, signal: abort.signal,
    fetch: async () => { requests++; throw new TypeError('Network failure'); },
    onConnected: () => assert.fail('offline'), onEvent: () => assert.fail('offline'),
    onDisconnected: () => undefined, wait: async () => { abort.abort(); },
  });
  assert.equal(requests, 1);
});

test('a receipt delivered after disconnection cannot restore an admission-only row to known queued', () => {
  const receipt = { ...record('queued'), source: 'admission_receipt' as const };
  const lost = markObservationLost([receipt]);
  assert.equal(appendDispatchRecord(lost, { ...receipt, observationLost: false })[0]?.observationLost, true);
  const late = { ...receipt, observationLost: true };
  assert.equal(appendDispatchRecord([], late)[0]?.observationLost, true);
  assert.equal(appendDispatchRecord([{ ...record('running'), observationLost: false }], late)[0]?.observationLost, false);
});

for (const path of ['/proxy/events', '/proxy/pet-sessions/events?petId=pet&sessionId=one']) {
  test(`client originates a heartbeat every 10 seconds for ${path} and stops on abort`, async (t) => {
    t.mock.timers.enable({ apis: ['setInterval'] });
    const abort = new AbortController();
    const requests: string[] = [];
    let connected!: () => void;
    const ready = new Promise<void>(resolve => { connected = resolve; });
    const observation = observeStudioEvents({ url: `http://host${path}`, headers: { Authorization: 'Bearer session' }, signal: abort.signal,
      fetch: async (input, init) => {
        requests.push(String(input));
        assert.deepEqual(init?.headers, { Authorization: 'Bearer session' });
        if (String(input).includes('/me?')) {
          assert.equal(init?.cache, 'no-store');
          if (requests.length === 3) abort.abort();
          return new Response('{}');
        }
        assert.equal(new URL(String(input)).searchParams.get('heartbeat'), '1');
        return new Response(new ReadableStream(), { headers: { 'X-Studio-Stream-Id': 'connection-only' } });
      },
      onConnected: connected, onEvent: () => assert.fail('no domain event required'),
      onDisconnected: () => assert.fail('user abort is not an error'),
    });
    try {
      await ready;
      assert.equal(requests.length, 2, 'the first heartbeat proves routing before claiming connected');
      t.mock.timers.tick(9_999);
      assert.equal(requests.length, 2);
      t.mock.timers.tick(1);
      await observation;
      assert.deepEqual(requests.slice(1), ['http://host/proxy/me?streamId=connection-only', 'http://host/proxy/me?streamId=connection-only']);
      t.mock.timers.tick(30_000);
      assert.equal(requests.length, 3);
    } finally { abort.abort(); t.mock.timers.reset(); }
  });
}

for (const status of [401, 403, 409]) {
  test(`a failed periodic heartbeat (${status}) cancels a quiet reader and reports its retry policy`, async (t) => {
    t.mock.timers.enable({ apis: ['setInterval'] });
    const abort = new AbortController();
    let connected!: () => void;
    const ready = new Promise<void>(resolve => { connected = resolve; });
    let heartbeats = 0;
    let cancelled = false;
    let disconnected = false;
    const observation = observeStudioEvents({ url: 'http://host/events', headers: {}, signal: abort.signal,
      fetch: async input => {
        if (String(input).includes('/me?')) return new Response('{}', { status: ++heartbeats === 1 ? 200 : status });
        return new Response(new ReadableStream({ cancel() { cancelled = true; } }), { headers: { 'X-Studio-Stream-Id': 'connection' } });
      },
      onConnected: connected, onEvent: () => assert.fail('no events'),
      onDisconnected: (error, retrying) => {
        assert.match(error.message, new RegExp(String(status)));
        assert.equal(retrying, status === 409);
        disconnected = true;
      },
      wait: async () => { abort.abort(); },
    });
    try {
      await ready;
      t.mock.timers.tick(10_000);
      await observation;
      assert.equal(cancelled, true);
      assert.equal(disconnected, true);
      t.mock.timers.tick(30_000);
      assert.equal(heartbeats, 2);
    } finally { abort.abort(); t.mock.timers.reset(); }
  });
}

test('an older local-token server without a lease header does not receive client heartbeats', async () => {
  const abort = new AbortController();
  let requests = 0;
  await observeStudioEvents({ url: 'http://host/events', headers: {}, signal: abort.signal,
    fetch: async () => { requests++; return stream([`data: ${JSON.stringify(event)}\n\n`]); },
    onConnected: () => undefined, onEvent: () => abort.abort(), onDisconnected: () => assert.fail('valid local stream'),
  });
  assert.equal(requests, 1);
});

test('aborting during the first heartbeat must not call onConnected', async () => {
  const abort = new AbortController();
  let connected = 0;
  await observeStudioEvents({ url: 'http://host/events', headers: {}, signal: abort.signal,
    fetch: async input => {
      if (String(input).includes('/me?')) {
        abort.abort();
        return new Response('{}');
      }
      return new Response(new ReadableStream(), { headers: { 'X-Studio-Stream-Id': 'conn' } });
    },
    onConnected: () => connected++, onEvent: () => assert.fail(), onDisconnected: () => assert.fail(),
  });
  assert.equal(connected, 0);
});

for (const status of [401, 403]) {
  test(`fetch-backed SSE abort must preserve heartbeat ${status} as terminal`, async (t) => {
    t.mock.timers.enable({ apis: ['setInterval'] });
    const abort = new AbortController();
    let connected!: () => void;
    const ready = new Promise<void>(resolve => { connected = resolve; });
    let heartbeats = 0;
    let result: { message: string; retrying: boolean } | undefined;
    const observation = observeStudioEvents({ url: 'http://host/events', headers: {}, signal: abort.signal,
      fetch: async (input, init) => {
        if (String(input).includes('/me?')) return new Response('{}', { status: ++heartbeats === 1 ? 200 : status });
        return new Response(new ReadableStream({ start(controller) {
          // Unlike an independent ReadableStream, fetch errors its body when
          // its request signal aborts, so a pending read rejects AbortError.
          init!.signal!.addEventListener('abort', () => controller.error(new DOMException('The operation was aborted.', 'AbortError')), { once: true });
        } }), { headers: { 'X-Studio-Stream-Id': 'connection' } });
      },
      onConnected: connected, onEvent: () => assert.fail('no events'),
      onDisconnected: (error, retrying) => { result = { message: error.message, retrying }; },
      wait: async () => { abort.abort(); },
    });
    try {
      await ready;
      t.mock.timers.tick(10_000);
      await observation;
      assert.equal(result?.retrying, false);
      assert.match(result?.message ?? '', new RegExp(String(status)));
    } finally { abort.abort(); t.mock.timers.reset(); }
  });
}
