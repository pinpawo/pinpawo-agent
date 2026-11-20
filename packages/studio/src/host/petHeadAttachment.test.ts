import assert from 'node:assert/strict';
import test from 'node:test';
import type { StudioEventSubscriptionFilter } from '../studioContract';
import { attachPetHead } from './petHead';

const pet = {
  petId: 'analyst', channelId: 'research', definitionId: 'worker', name: 'Analyst', createdAt: '2026-11-20T00:00:00Z',
};

const dependencies = {
  pet,
  channel: {
    readContext: async () => { throw new Error('unexpected context read'); },
    reply: async () => { throw new Error('unexpected reply'); },
    dispatch: async () => { throw new Error('unexpected dispatch'); },
  },
  getQueueSnapshot: () => { throw new Error('activation must not read the runtime queue'); },
  resolveModel: () => { throw new Error('activation must not build the model'); },
};

test('Head attachment rolls back the resident observation if Timeline subscription fails', () => {
  const failure = new Error('Timeline attachment failed');
  const attached = new Set<string>();
  const filters: StudioEventSubscriptionFilter[] = [];
  const signal = new AbortController().signal;
  assert.throws(() => attachPetHead({
    ...dependencies,
    subscribe: (_handler, filter) => {
      assert.ok(filter);
      filters.push(filter);
      if (filter.source === 'channel') throw failure;
      attached.add(filter.topic);
      return () => { attached.delete(filter.topic); };
    },
  }, signal), failure);
  assert.deepEqual(filters, [{ source: 'resident-pet', topic: pet.petId }, { source: 'channel', topic: pet.channelId }]);
  assert.equal(attached.size, 0, 'nothing remains attached even before PetInstance aborts on activation failure');
});

test('Head attachment uses the given activation signal and releases both subscriptions', () => {
  const controller = new AbortController();
  const released: string[] = [];
  const close = attachPetHead({
    ...dependencies,
    subscribe: (_handler, filter) => () => {
      assert.equal(controller.signal.aborted, true);
      released.push(filter!.source);
    },
  }, controller.signal);
  controller.abort();
  close();
  assert.deepEqual(released, ['channel', 'resident-pet']);
  assert.throws(() => attachPetHead({
    ...dependencies,
    subscribe: () => assert.fail('an already-aborted activation cannot subscribe'),
  }, controller.signal), { name: 'AbortError' });
});
