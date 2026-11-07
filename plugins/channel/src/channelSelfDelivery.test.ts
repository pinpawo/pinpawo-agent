import assert from 'node:assert/strict';
import test from 'node:test';
import { setTimeout } from 'node:timers/promises';
import { createStudioStorage, type StudioDispatchRequest, type StudioEvent, type StudioPluginContext } from '@pinpawo/studio-core';
import { createChannelPlugin } from './channelPlugin';
import { channelParticipantId } from './channelParticipants';
import type { RouteInput } from './channelRouting';

async function setup(t: test.TestContext, authorId = 'writer', otherId = 'reviewer') {
  const storage = createStudioStorage({ kind: 'sqlite', path: ':memory:' });
  t.after(() => storage.close());
  const dispatched: StudioDispatchRequest[] = [];
  const decisions: RouteInput[] = [];
  const events: Array<{ type: string; payload?: unknown }> = [];
  const listeners: Array<(event: StudioEvent) => unknown> = [];
  const allocated: string[] = [];
  let target = channelParticipantId('pet', otherId);
  const plugin = createChannelPlugin({ httpRoute: false, routing: { enabled: true }, routeDecider: async input => {
    decisions.push(input);
    return { target, confidence: 1 };
  } });
  const context = {
    dispatch: async (request: StudioDispatchRequest) => {
      dispatched.push(request);
      return { petId: request.petId, invocationId: `dispatch-${dispatched.length}` };
    },
    allocateSessionId: (petId: string) => { allocated.push(petId); return `session-${allocated.length}`; },
    registerContextProvider: () => () => undefined,
    notify: (event: { type: string; payload?: unknown }) => { events.push(event); },
    subscribe: (listener: (event: StudioEvent) => unknown) => { listeners.push(listener); return () => undefined; },
    listPets: () => [authorId, otherId].map(petId => ({ petId, name: 'Same name', definitionId: petId })),
    listDispatchQueues: () => [],
    clients: { get: async (clientId: string) => ({ clientId, label: 'Same name' }) },
    storage: { dialect: 'sqlite', open: (migrations: Parameters<typeof storage.open>[1]) => storage.open('channel', migrations) },
    hooks: { expose: () => () => undefined },
    models: { resolve: () => { throw new Error('No model is used by this test.'); } },
  } as unknown as StudioPluginContext;
  await plugin.start!(context);
  t.after(() => plugin.stop?.());
  const human = { kind: 'human' as const, id: authorId };
  const author = { kind: 'pet' as const, id: authorId };
  const channelId = (await plugin.service.createChannel(human, { title: 'Self delivery', pets: [authorId, otherId] })).channel.channelId;
  const emit = async (messageId: string, text: string, sessionId: string) => {
    for (const listener of listeners) await listener({
      eventId: messageId, type: 'dispatch.message', source: 'resident-pet', occurredAt: '2026-11-07T00:00:00Z',
      payload: { petId: authorId, sessionId, scope: { namespace: 'channel', id: channelId },
        message: { type: 'message.completed', messageId, text } },
    });
  };
  return { plugin, channelId, author, human, dispatched, decisions, events, allocated, emit,
    select: (participantId: string) => { target = participantId; } };
}

test('Pet self-only mentions stay stored but neither dispatch nor fall back to routing', async t => {
  const { plugin, channelId, author, dispatched, decisions, events, allocated } = await setup(t);
  for (const input of [
    { body: 'My update.', mentions: [{ participantId: 'pet:writer' }] },
    { body: '[@Same name](participant:pet:writer) My update.' },
  ]) {
    const { message, deliveries } = await plugin.sendMessage(channelId, input, author);
    assert.deepEqual(message.mentions, [{ participantId: 'pet:writer', label: 'Same name' }]);
    assert.deepEqual(deliveries, []);
    assert.deepEqual((await plugin.service.getMessage(channelId, message.messageId))?.mentions, message.mentions);
  }
  await setTimeout(25);
  assert.equal(dispatched.length, 0);
  assert.deepEqual(allocated, [], 'self mentions never reserve a session');
  assert.deepEqual(decisions, [], 'filtering delivery does not make a self mention unaddressed');
  assert.ok(!events.some(event => event.type === 'channel.delivery'));
});

test('mixed mentions exclude only the Pet author across kind, label and encoded-id collisions', async t => {
  const authorId = 'same/id', otherId = 'same%2Fid';
  const { plugin, channelId, author, human, dispatched, decisions, allocated } = await setup(t, authorId, otherId);
  const own = channelParticipantId('pet', authorId), other = channelParticipantId('pet', otherId);
  const person = channelParticipantId('human', human.id);
  const attachments = [{ uri: 'artifact://workspace/result.png', title: 'Result' }];
  const { message, deliveries } = await plugin.sendMessage(channelId, { body: 'Same name, this result is ready.',
    mentions: [own, other, person].map(participantId => ({ participantId })), deliverables: attachments,
  }, author);
  assert.deepEqual(message.mentions.map(mention => mention.participantId), [own, other, person]);
  assert.deepEqual(deliveries.map(({ participantId, state }) => ({ participantId, state })), [
    { participantId: other, state: 'accepted' }, { participantId: person, state: 'delivered' },
  ]);
  assert.deepEqual(dispatched.map(request => request.petId), [otherId]);
  assert.deepEqual(dispatched[0]!.attachments, attachments);
  assert.deepEqual(allocated, [otherId]);
  assert.equal(await plugin.service.getSession(channelId, authorId), undefined);
  // A human with the same raw id and label is a different author, so can reach this Pet.
  await plugin.sendMessage(channelId, { body: 'Please inspect.', mentions: [{ participantId: own }] }, human);
  assert.deepEqual(dispatched.map(request => request.petId), [otherId, authorId]);
  await setTimeout(25);
  assert.deepEqual(decisions, []);
});

test('replayed public Pet self mentions never dispatch, while mixed public mentions still reach others', async t => {
  const { plugin, channelId, dispatched, decisions, events, emit } = await setup(t);
  const binding = await plugin.service.reserveSession(channelId, 'writer', () => 'existing-writer');
  await plugin.service.confirmSession(binding);
  const self = '[@Same name](participant:pet:writer) My result is ready.';
  await emit('self-result', self, binding.sessionId);
  await emit('self-result', self, binding.sessionId);
  const mixed = '[@Same name](participant:pet:writer) [@Same name](participant:pet:reviewer) [@Same name](participant:human:writer) Shared result.';
  await emit('mixed-result', mixed, binding.sessionId);
  await emit('mixed-result', mixed, binding.sessionId);
  await setTimeout(25);
  assert.deepEqual(dispatched.map(request => request.petId), ['reviewer']);
  assert.deepEqual(decisions, []);
  const messages = (await plugin.service.readContext({ kind: 'pet', id: 'writer' }, channelId)).messages;
  assert.deepEqual(messages.map(message => message.externalRef), ['self-result', 'mixed-result']);
  assert.deepEqual(messages[0]!.mentions.map(mention => mention.participantId), ['pet:writer']);
  const deliveries = events.filter(event => event.type === 'channel.delivery').map(event => event.payload as { participantId: string; state: string });
  assert.deepEqual(deliveries.map(({ participantId, state }) => ({ participantId, state })), [
    { participantId: 'pet:reviewer', state: 'accepted' }, { participantId: 'human:writer', state: 'delivered' },
  ]);
});

test('routing rejects the stored Pet author but permits a human with the same id to reach it', async t => {
  const { plugin, channelId, author, human, dispatched, decisions, events, select } = await setup(t);
  select('pet:writer');
  await plugin.sendMessage(channelId, { body: 'I am a human named Same name.' }, author);
  for (let i = 0; i < 200 && !events.some(event => event.type === 'channel.routing.skipped'); i++) await setTimeout(5);
  assert.ok(events.some(event => event.type === 'channel.routing.skipped'
    && (event.payload as { reason: string }).reason === 'invalid'));
  assert.deepEqual(decisions[0]!.pets.map(pet => pet.participantId), ['pet:reviewer']);
  assert.equal(dispatched.length, 0);
  await plugin.sendMessage(channelId, { body: 'I am writer.' }, human);
  for (let i = 0; i < 200 && dispatched.length === 0; i++) await setTimeout(5);
  assert.deepEqual(dispatched.map(request => request.petId), ['writer']);
});

test('scheduled Channel inputs remain Pet actions rather than self-authored messages', async t => {
  const { plugin, channelId, dispatched } = await setup(t);
  await plugin.run(channelId, 'writer', 'Check the project.', { kind: 'scheduler', id: 'daily' });
  assert.deepEqual(dispatched.map(request => request.petId), ['writer']);
});
