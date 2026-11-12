import assert from 'node:assert/strict';
import test from 'node:test';

import { StudioEventBus } from './studioEventBus';
import type { StudioEvent } from './studioContract';

const event = (type: string): StudioEvent => ({
  eventId: type, type, source: 'test', occurredAt: '2026-01-01T00:00:00.000Z',
});
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

test('broadcast has no offline replay and unsubscribe excludes later publications', async () => {
  const bus = new StudioEventBus();
  const seen: string[] = [];
  bus.publish(event('before'));
  const unsubscribe = bus.subscribe(value => { seen.push(value.type); });
  bus.publish(event('during'));
  await tick();
  assert.deepEqual(seen, ['during']);
  unsubscribe();
  unsubscribe();
  bus.publish(event('after'));
  await tick();
  assert.deepEqual(seen, ['during']);
  await bus.close();
});

test('subscriber FIFO isolates slow work and skips pending events after unsubscribe', async () => {
  const bus = new StudioEventBus();
  const started = deferred();
  const release = deferred();
  const fastFinished = deferred();
  const slowSeen: string[] = [];
  const fastSeen: string[] = [];
  const unsubscribe = bus.subscribe(async value => {
    slowSeen.push(value.type);
    if (value.type === 'first') { started.resolve(); await release.promise; }
  });
  bus.subscribe(value => {
    fastSeen.push(value.type);
    if (value.type === 'second') fastFinished.resolve();
  });
  bus.publish(event('first'));
  bus.publish(event('second'));
  await started.promise;
  await fastFinished.promise;
  assert.deepEqual(slowSeen, ['first']);
  assert.deepEqual(fastSeen, ['first', 'second']);
  unsubscribe();
  release.resolve();
  await tick();
  assert.deepEqual(slowSeen, ['first']);
  await bus.close();
});

test('synchronous and asynchronous failures do not stop later events or other subscribers', async () => {
  const bus = new StudioEventBus();
  const seen: string[] = [];
  const finished = deferred();
  const errors: unknown[][] = [];
  const recovered: string[] = [];
  const originalError = console.error;
  console.error = (...args: unknown[]) => { errors.push(args); };
  try {
    bus.subscribe(value => { if (value.type === 'first') throw new Error('sync failure'); recovered.push('sync'); });
    bus.subscribe(async value => { if (value.type === 'first') throw new Error('async failure'); recovered.push('async'); });
    bus.subscribe(value => { seen.push(value.type); if (value.type === 'second') finished.resolve(); });
    bus.publish(event('first'));
    bus.publish(event('second'));
    await finished.promise;
    await tick();
    assert.deepEqual(seen, ['first', 'second']);
    assert.equal(errors.length, 2);
    assert.deepEqual(recovered.sort(), ['async', 'sync']);
  } finally {
    console.error = originalError;
    await bus.close();
  }
});


test('close does not wait for a stalled handler and skips its pending events', async () => {
  const bus = new StudioEventBus();
  const started = deferred();
  const release = deferred();
  const seen: string[] = [];
  bus.subscribe(async value => {
    seen.push(value.type);
    if (value.type === 'first') { started.resolve(); await release.promise; }
  });
  bus.publish(event('first'));
  bus.publish(event('second'));
  await started.promise;
  await bus.close();
  release.resolve();
  await tick();
  assert.deepEqual(seen, ['first']);
});

test('an already published event can start while close is in progress', async () => {
  const bus = new StudioEventBus();
  let closing = false;
  let closed = false;
  const seen: string[] = [];
  bus.subscribe(value => {
    assert.equal(closing, true);
    assert.equal(closed, false);
    seen.push(value.type);
  });
  bus.publish(event('before-close'));
  closing = true;
  await bus.close();
  closed = true;
  assert.deepEqual(seen, ['before-close']);
});
