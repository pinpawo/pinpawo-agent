import assert from 'node:assert/strict';
import test from 'node:test';

import { StudioEventBus } from './studioEventBus';
import type { StudioEvent } from './studioContract';

const event = (type: string): StudioEvent => ({
  eventId: type, type, source: 'test', occurredAt: '2026-01-01T00:00:00.000Z',
});

test('broadcast has no replay and unsubscribe excludes future publications', async () => {
  const bus = new StudioEventBus();
  const seen: string[] = [];
  bus.publish(event('before'));
  const unsubscribe = bus.subscribe(value => { seen.push(value.type); });
  bus.publish(event('during'));
  unsubscribe();
  unsubscribe();
  bus.publish(event('after'));
  assert.deepEqual(seen, ['during']);
  await bus.close();
});

test('synchronous and asynchronous handler failures do not stop other subscribers', async () => {
  const bus = new StudioEventBus();
  const seen: string[] = [];
  const errors: unknown[][] = [];
  const originalError = console.error;
  console.error = (...args: unknown[]) => { errors.push(args); };
  try {
    bus.subscribe(() => { throw new Error('sync failure'); });
    bus.subscribe(async () => { throw new Error('async failure'); });
    bus.subscribe(value => { seen.push(value.type); });
    bus.publish(event('message'));
    assert.deepEqual(seen, ['message']);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(errors.length, 2);
  } finally {
    console.error = originalError;
    await bus.close();
  }
});

test('publication snapshots subscriptions and ignores one removed during broadcast', async () => {
  const bus = new StudioEventBus();
  const seen: string[] = [];
  let removeSecond = () => {};
  bus.subscribe(() => {
    removeSecond();
    bus.subscribe(value => { seen.push(`new:${value.type}`); });
  });
  removeSecond = bus.subscribe(value => { seen.push(`removed:${value.type}`); });
  bus.publish(event('first'));
  bus.publish(event('second'));
  assert.deepEqual(seen, ['new:second']);
  await bus.close();
});

