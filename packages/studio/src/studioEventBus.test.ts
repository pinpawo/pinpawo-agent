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

test('exact producer topics route independently while global subscribers see each event once', async () => {
  const bus = new StudioEventBus();
  const selected: string[] = [];
  const global: StudioEvent[] = [];
  const filter = { source: 'channel', topic: 'team' };
  const routed = (type: string, fields: Partial<StudioEvent> = {}): StudioEvent => ({ ...event(type), ...filter, ...fields });
  bus.publish(routed('before'));
  const unsubscribe = bus.subscribe(value => { selected.push(value.type); }, filter);
  bus.subscribe(value => { global.push(value); });
  const publications = [
    routed('owned'),
    routed('other-channel', { topic: 'other' }),
    routed('other-producer', { source: 'other' }),
    { ...event('without-topic'), source: 'channel' },
  ];
  for (const value of publications) bus.publish(value);
  await tick();
  assert.deepEqual(selected, ['owned']);
  assert.deepEqual(global, publications);
  unsubscribe();
  unsubscribe();
  bus.publish(routed('offline'));
  const reopened = bus.subscribe(value => { selected.push(value.type); }, filter);
  bus.publish(routed('reopened'));
  await tick();
  assert.deepEqual(selected, ['owned', 'reopened']);
  reopened();
  await bus.close();
});

test('source and topic keys are opaque exact strings, including emitter metacharacters', async () => {
  const bus = new StudioEventBus();
  const routes = [
    { source: 'channel', topic: 'team' },
    { source: 'channel', topic: 'team/other' },
    { source: 'channel', topic: '+' },
    { source: 'channel', topic: '#' },
    { source: 'channel', topic: '' },
    { source: 'channel', topic: '频道' },
    { source: 'channel', topic: '\ud800' },
    { source: 'channel', topic: '\ud801' },
    { source: 'source/+#', topic: 'team' },
    { source: '', topic: 'team' },
  ];
  const seen = routes.map(() => [] as string[]);
  routes.forEach((route, index) => {
    bus.subscribe(value => { seen[index]!.push(value.type); }, route);
  });
  routes.forEach((route, index) => bus.publish({ ...event(String(index)), ...route }));
  bus.publish({ ...event('without-topic'), source: 'channel' });
  await tick();
  assert.deepEqual(seen, routes.map((_, index) => [String(index)]));
  await bus.close();
});

test('scoped subscriber FIFO isolates slow work and drops pending events on owner release', async () => {
  const bus = new StudioEventBus();
  const filter = { source: 'channel', topic: 'team' };
  const started = deferred();
  const release = deferred();
  const fastFinished = deferred();
  const slowSeen: string[] = [];
  const fastSeen: string[] = [];
  const otherSeen: string[] = [];
  bus.subscribe(async value => {
    slowSeen.push(value.type);
    if (value.type === 'first') { started.resolve(); await release.promise; }
  }, filter, 'slow-plugin');
  bus.subscribe(value => {
    fastSeen.push(value.type);
    if (value.type === 'second') fastFinished.resolve();
  }, filter);
  bus.subscribe(value => { otherSeen.push(value.type); }, { source: 'channel', topic: 'other' });
  bus.publish({ ...event('first'), ...filter });
  bus.publish({ ...event('other'), source: 'channel', topic: 'other' });
  bus.publish({ ...event('second'), ...filter });
  await started.promise;
  await fastFinished.promise;
  assert.deepEqual(slowSeen, ['first']);
  assert.deepEqual(fastSeen, ['first', 'second']);
  assert.deepEqual(otherSeen, ['other']);
  bus.releaseOwner('slow-plugin');
  bus.releaseOwner('slow-plugin');
  release.resolve();
  bus.publish({ ...event('after-release'), ...filter });
  await tick();
  assert.deepEqual(slowSeen, ['first']);
  assert.deepEqual(fastSeen, ['first', 'second', 'after-release']);
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
