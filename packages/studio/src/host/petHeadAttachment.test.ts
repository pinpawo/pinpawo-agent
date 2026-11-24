import assert from 'node:assert/strict';
import { AIMessage } from '@langchain/core/messages';
import test from 'node:test';
import type { StudioEvent, StudioEventHandler, StudioEventSubscriptionFilter, StudioModelEndpoint } from '../studioContract';
import { attachPetHead } from './petHead';

const pet = {
  petId: 'analyst', channelId: 'research', definitionId: 'worker', name: 'Analyst', createdAt: '2026-11-20T00:00:00Z',
};

const dependencies = {
  pet,
  channel: {
    readSession: async () => { throw new Error('unexpected Session read'); },
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
  close();
  assert.deepEqual(released, ['channel', 'resident-pet']);
  assert.throws(() => attachPetHead({
    ...dependencies,
    subscribe: () => assert.fail('an already-aborted activation cannot subscribe'),
  }, controller.signal), { name: 'AbortError' });
});


test('closing the Head directly fences a pending Timeline turn and releases both subscriptions once', { timeout: 2000 }, async () => {
  const parent = new AbortController();
  const listeners = new Map<string, StudioEventHandler>();
  const releases: string[] = [];
  const effects: string[] = [];
  let enter!: (signal: AbortSignal) => void;
  let release!: () => void;
  const entered = new Promise<AbortSignal>(resolve => { enter = resolve; });
  const pending = new Promise<void>(resolve => { release = resolve; });
  const close = attachPetHead({
    ...dependencies,
    channel: {
      readContext: async () => {
        effects.push('context');
        return { messages: [], members: [{ kind: 'pet', id: pet.petId, participantId: 'pet:analyst' }] };
      },
      readSession: async () => ({ status: 'ready' }),
      reply: async () => { effects.push('reply'); },
      dispatch: async () => { effects.push('dispatch'); },
    },
    getQueueSnapshot: () => ({ state: 'open', activeOperation: null, queuedConversations: 0, queuedDispatches: 0 }),
    resolveModel: () => ({
      profileId: 'test', baseUrl: 'https://models.example.test', apiKey: 'test-key', model: 'scripted',
      createChatModel: () => ({
        withStructuredOutput: (_schema: unknown, { name }: { name: string }) => {
          assert.equal(name, 'pet_head_idle', 'the committed mention qualifies this turn directly');
          return { invoke: async (_messages: unknown, { signal }: { signal: AbortSignal }) => {
            enter(signal);
            await pending;
            const parsed = { shouldDispatch: true, reply: 'This is too late.' };
            return { raw: new AIMessage(JSON.stringify(parsed)), parsed };
          } };
        },
      }) as unknown as ReturnType<NonNullable<StudioModelEndpoint['createChatModel']>>,
    }),
    subscribe: (handler, filter) => {
      assert.ok(filter);
      const { source } = filter;
      listeners.set(source, handler);
      return () => { releases.push(source); listeners.delete(source); };
    },
  }, parent.signal);
  const event: StudioEvent = {
    eventId: 'live', type: 'channel.message.created', source: 'channel', topic: pet.channelId,
    occurredAt: '2026-11-20T00:00:00Z',
    payload: { messageId: 'live', channelId: pet.channelId, sequence: 1, author: { kind: 'human', id: 'owner' },
      mentions: [{ participantId: 'pet:analyst' }], body: 'Run the analysis.' },
  };
  const listener = listeners.get('channel');
  assert.ok(listener);
  const turn = listener(event);
  try {
    const signal = await entered;
    close();
    close();
    assert.equal(parent.signal.aborted, false);
    assert.equal(signal.aborted, true);
    assert.equal(listeners.size, 0);
    assert.deepEqual(releases, ['channel', 'resident-pet']);
    // A captured callback cannot start another turn after the Head closes.
    await listener(event);
  } finally {
    release();
    close();
  }
  await assert.rejects(async () => turn, /Pet Head idle handler aborted/);
  assert.deepEqual(effects, ['context']);
});

test('closing the Head still releases resident observation if Timeline unsubscribe throws', () => {
  const failure = new Error('Timeline unsubscribe failed');
  let releases = 0;
  const close = attachPetHead({
    ...dependencies,
    subscribe: (_handler, filter) => {
      if (filter?.source === 'channel') return () => { throw failure; };
      return () => { releases++; };
    },
  }, new AbortController().signal);
  assert.throws(close, failure);
  close();
  assert.equal(releases, 1);
});
