import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { type StudioEvent } from '@pinpawo/studio-core';
import type { PetInvocationScope } from 'pinpawo/host-runtime';
import { createChannelPlugin, type RouteDecision, type RouteInput } from '@pinpawo-plugin/channel';
import { readChannelTestInput } from '../../support/channelDispatchInput';
import { createStudioWithPets } from '../../../tests/support/livePets';

const me = { kind: 'human' as const, id: 'local' };

async function waitFor(done: () => boolean) {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (done()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('Timed out waiting for routing.');
}

type Dispatched = { petId: string; request: string; session?: { id: string; create?: boolean }; scope?: PetInvocationScope };
const fakePet = (petId: string, dispatched: Dispatched[]) => ({
  registration: { petId, name: petId[0]!.toUpperCase() + petId.slice(1) }, dispatch: {
    getQueueSnapshot: () => ({ state: 'open' as const, activeOperation: null, queuedConversations: 0, queuedDispatches: 0 }),
    onQueueChange: () => () => {}, onDispatchLifecycle: () => () => {},
    dispatch: async (input: Omit<Dispatched, 'petId'>) => { dispatched.push({ petId, ...input }); },
  },
});

async function routedStudio(decide: (input: RouteInput) => RouteDecision | Promise<RouteDecision>) {
  const dispatched: Dispatched[] = [];
  const seen: RouteInput[] = [];
  const channel = createChannelPlugin({
    httpRoute: false,
    routing: { enabled: true, pets: { executor: 'Runs the work.' } },
    routeDecider: async (input) => { seen.push(input); return decide(input); },
  });
  const studio = await createStudioWithPets({
    studioId: 'test', plugins: [channel],
    pets: [fakePet('executor', dispatched), fakePet('reviewer', dispatched)],
  });
  const events: StudioEvent[] = [];
  studio.subscribe(event => { if (event.type.startsWith('channel.')) events.push(event); });
  const { channel: { channelId } } = await channel.service.createChannel(me, { title: 'Release', pets: ['executor', 'reviewer'] });
  return { studio, channel, channelId, dispatched, seen, events };
}

test('routing hands an unaddressed human message to the chosen Pet through the Channel session', async (t) => {
  const { studio, channel, channelId, dispatched, seen, events } = await routedStudio(
    () => ({ target: 'pet:executor', confidence: 0.9, reason: 'It opened #1003.' }));
  t.after(() => studio.shutdown());
  await channel.service.postMessage({ kind: 'pet', id: 'executor' }, channelId, { body: 'Opened #1003.' });
  const { message, deliveries } = await channel.sendMessage(channelId, { body: 'Who is handling #1003?' }, me);
  assert.deepEqual(deliveries, [], 'the poster does not wait on routing');
  await waitFor(() => dispatched.length === 1);

  assert.equal(dispatched[0]!.petId, 'executor');
  assert.deepEqual(dispatched[0]!.scope, { namespace: 'channel', id: channelId });
  const input = readChannelTestInput(dispatched[0]!.request);
  assert.deepEqual([input.messageId, input.body, input.addressedBy], [message.messageId, 'Who is handling #1003?', 'routing']);

  assert.deepEqual(seen[0]!.history, [{ author: 'Executor', authorIdentity: { participantId: 'pet:executor', kind: 'pet' }, body: 'Opened #1003.' }]);
  assert.deepEqual(seen[0]!.pets.map(pet => [pet.participantId, pet.description]), [['pet:executor', 'Runs the work.'], ['pet:reviewer', undefined]]);
  await waitFor(() => events.some(event => event.type === 'channel.delivery'));
  const delivery = events.find(event => event.type === 'channel.delivery')!.payload as Record<string, unknown>;
  assert.deepEqual([delivery.participantId, delivery.state, delivery.via, delivery.confidence, delivery.reason],
    ['pet:executor', 'accepted', 'routing', 0.9, 'It opened #1003.']);
  assert.deepEqual((await channel.service.getMessage(channelId, message.messageId))?.mentions, [], 'the message is stored as written');
});

test('routing leaves addressed messages and low-confidence decisions alone', async (t) => {
  let decision: RouteDecision = { target: 'pet:executor', confidence: 0.2 };
  const { studio, channel, channelId, dispatched, seen, events } = await routedStudio(() => decision);
  t.after(() => studio.shutdown());

  await channel.sendMessage(channelId, { body: 'Review this', mentions: [{ participantId: 'pet:reviewer' }] }, me);
  assert.deepEqual(dispatched.map(item => item.petId), ['reviewer']);

  await channel.sendMessage(channelId, { body: 'thanks!' }, me);
  await waitFor(() => events.some(event => event.type === 'channel.routing.skipped'));
  const skipped = events.find(event => event.type === 'channel.routing.skipped')!.payload as Record<string, unknown>;
  assert.deepEqual([skipped.reason, skipped.confidence], ['low_confidence', 0.2]);

  decision = { target: 'none', confidence: 0.95 };
  await channel.sendMessage(channelId, { body: 'lunch?' }, me);
  await waitFor(() => events.filter(event => event.type === 'channel.routing.skipped').length === 2);
  assert.equal(seen.length, 2, 'only the two unaddressed human messages reached the decider');
  assert.deepEqual(dispatched.map(item => item.petId), ['reviewer']);
});

test('a public Pet reply without mentions routes once with dynamic focus and preserves its author', async (t) => {
  const focus = `Reconcile the delivered evidence ${randomUUID()} with the existing implementation.`;
  const reason = 'The implementation owner can reconcile the result.';
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const { studio, channel, channelId, dispatched, seen, events } = await routedStudio(async () => {
    await held;
    return { target: 'pet:executor', confidence: 0.95, reason, focus };
  });
  t.after(async () => { release(); await studio.shutdown(); });
  const { deliveries: [start] } = await channel.sendMessage(channelId,
    { body: 'Review the completed change.', mentions: [{ participantId: 'pet:reviewer' }] }, me);
  const body = 'The change matches the requested behavior; the implementation owner can record the result.';
  const payload = {
    petId: 'reviewer', invocationId: start!.invocationId, sessionId: start!.sessionId,
    scope: { namespace: 'channel', id: channelId },
    message: { type: 'message.completed', messageId: 'unaddressed-review', role: 'assistant', text: body },
  };
  const emit = () => studio.notify({ source: 'resident-pet', type: 'dispatch.message',
    occurredAt: new Date().toISOString(), payload });
  emit();
  emit();
  await waitFor(() => seen.length === 1);
  assert.equal(dispatched.length, 1, 'a pending routing decision has not dispatched its target');
  assert.equal(seen[0]!.message.author, 'Reviewer');
  assert.deepEqual(seen[0]!.message.authorIdentity, { participantId: 'pet:reviewer', kind: 'pet' });
  assert.deepEqual(seen[0]!.pets.map(pet => pet.participantId), ['pet:executor'], 'the author is not a candidate');
  release();
  await waitFor(() => dispatched.length === 2);
  await waitFor(() => events.some(event => event.type === 'channel.delivery'
    && (event.payload as Record<string, unknown>).via === 'routing'));
  const publicMessages = (await channel.service.readContext(me, channelId)).messages.filter(message => message.author.kind === 'pet');
  assert.equal(publicMessages.length, 1);
  assert.deepEqual(publicMessages[0]!.mentions, [], 'routing does not rewrite the public message');
  const input = readChannelTestInput(dispatched[1]!.request);
  assert.equal(dispatched[1]!.petId, 'executor');
  assert.deepEqual(input.author, { participantId: 'pet:reviewer', kind: 'pet', label: 'Reviewer' });
  assert.equal(input.messageId, publicMessages[0]!.messageId);
  assert.equal(input.body, body);
  assert.equal(input.addressedBy, 'routing');
  assert.equal(input.contextHint?.focus, focus);
  assert.equal(input.contextHint?.action, 'read-latest-channel');
  assert.ok(!dispatched[1]!.request.includes(reason), 'the decider explanation is not a task instruction');

  emit();
  await new Promise(resolve => setTimeout(resolve, 25));
  assert.equal(seen.length, 1, 'concurrent and later replays do not repeat the model decision');
  assert.equal(dispatched.length, 2, 'one stored public message dispatches its target once');
});

test('public Pet replies honor explicit mentions and never route an invalid mention as unaddressed', async (t) => {
  const { studio, channel, channelId, dispatched, seen, events } = await routedStudio(
    () => ({ target: 'pet:executor', confidence: 1, focus: 'This should not be dispatched.' }));
  t.after(() => studio.shutdown());
  const { deliveries: [start] } = await channel.sendMessage(channelId,
    { body: 'Review the change.', mentions: [{ participantId: 'pet:reviewer' }] }, me);
  const emit = (messageId: string, text: string) => studio.notify({
    source: 'resident-pet', type: 'dispatch.message', occurredAt: new Date().toISOString(),
    payload: { petId: 'reviewer', invocationId: start!.invocationId, sessionId: start!.sessionId,
      scope: { namespace: 'channel', id: channelId },
      message: { type: 'message.completed', messageId, role: 'assistant', text } },
  });
  emit('explicit-handoff', '[@Executor](participant:pet:executor) The review is ready.');
  await waitFor(() => dispatched.length === 2);
  const addressed = readChannelTestInput(dispatched[1]!.request);
  assert.equal(addressed.addressedBy, undefined);
  assert.equal(addressed.contextHint, undefined);
  emit('invalid-handoff', '[@Missing](participant:pet:missing) The review is ready.');
  await waitFor(() => events.some(event => event.type === 'channel.delivery'
    && (event.payload as Record<string, unknown>).state === 'failed'));
  emit('human-handoff', '[@Local](participant:human:local) Please decide.');
  await waitFor(() => events.some(event => event.type === 'channel.delivery'
    && (event.payload as Record<string, unknown>).participantId === 'human:local'));
  await new Promise(resolve => setTimeout(resolve, 25));
  assert.equal(seen.length, 0, 'valid, invalid and human mentions all stay outside unaddressed routing');
  assert.deepEqual(dispatched.map(item => item.petId), ['reviewer', 'executor']);
  const saved = (await channel.service.readContext(me, channelId)).messages.find(message => message.externalRef === 'invalid-handoff');
  assert.ok(saved, 'the public reply is retained even when its mention is invalid');
});

test('Pet self-selection is rejected and an acknowledgement with none stops without another dispatch', async (t) => {
  const { studio, channel, channelId, dispatched, seen, events } = await routedStudio(input =>
    input.message.body === 'Acknowledged.' ? { target: 'none', confidence: 1 }
      : { target: 'pet:reviewer', confidence: 1, focus: 'Repeat my review.' });
  t.after(() => studio.shutdown());
  const { deliveries: [start] } = await channel.sendMessage(channelId,
    { body: 'Review the change.', mentions: [{ participantId: 'pet:reviewer' }] }, me);
  const emit = (messageId: string, text: string) => studio.notify({
    source: 'resident-pet', type: 'dispatch.message', occurredAt: new Date().toISOString(),
    payload: { petId: 'reviewer', invocationId: start!.invocationId, sessionId: start!.sessionId,
      scope: { namespace: 'channel', id: channelId },
      message: { type: 'message.completed', messageId, role: 'assistant', text } },
  });
  emit('self-selection', 'My review is complete.');
  await waitFor(() => events.some(event => event.type === 'channel.routing.skipped'));
  emit('acknowledgement', 'Acknowledged.');
  await waitFor(() => events.filter(event => event.type === 'channel.routing.skipped').length === 2);
  assert.deepEqual(events.filter(event => event.type === 'channel.routing.skipped')
    .map(event => (event.payload as Record<string, unknown>).reason), ['invalid', 'none']);
  assert.ok(seen.every(input => input.pets.every(pet => pet.participantId !== 'pet:reviewer')));
  assert.deepEqual(dispatched.map(item => item.petId), ['reviewer']);
});

test('without routing an unaddressed message wakes no Pet', async (t) => {
  const dispatched: Dispatched[] = [];
  const channel = createChannelPlugin({ httpRoute: false });
  const studio = await createStudioWithPets({ studioId: 'test', plugins: [channel], pets: [fakePet('executor', dispatched)] });
  t.after(() => studio.shutdown());
  const { channel: { channelId } } = await channel.service.createChannel(me, { title: 'Quiet', pets: ['executor'] });
  await channel.sendMessage(channelId, { body: 'Who is handling #1003?' }, me);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(dispatched.length, 0);
});
