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
