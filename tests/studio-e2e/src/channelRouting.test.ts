import assert from 'node:assert/strict';
import test from 'node:test';
import { createStudio, type StudioEvent } from '@pinpawo/studio-core';
import type { PetInvocationScope } from 'pinpawo/host-runtime';
import { createChannelPlugin, type RouteDecision, type RouteInput } from '@pinpawo-plugin/channel';
import { readChannelTestInput } from '../../support/channelDispatchInput';

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

async function routedStudio(decide: (input: RouteInput) => RouteDecision) {
  const dispatched: Dispatched[] = [];
  const seen: RouteInput[] = [];
  const channel = createChannelPlugin({
    httpRoute: false,
    routing: { enabled: true, pets: { executor: 'Runs the work.' } },
    routeDecider: async (input) => { seen.push(input); return decide(input); },
  });
  const studio = await createStudio({
    studioId: 'test', entryPetId: 'executor', plugins: [channel],
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

  assert.deepEqual(seen[0]!.history, [{ author: 'Executor', body: 'Opened #1003.' }]);
  assert.deepEqual(seen[0]!.pets.map(pet => [pet.participantId, pet.description]), [['pet:executor', 'Runs the work.'], ['pet:reviewer', undefined]]);
  await waitFor(() => events.some(event => event.type === 'channel.delivery'));
  const delivery = events.find(event => event.type === 'channel.delivery')!.payload as Record<string, unknown>;
  assert.deepEqual([delivery.participantId, delivery.state, delivery.via, delivery.confidence, delivery.reason],
    ['pet:executor', 'accepted', 'routing', 0.9, 'It opened #1003.']);
  assert.deepEqual((await channel.service.getMessage(channelId, message.messageId))?.mentions, [], 'the message is stored as written');
});

test('routing leaves addressed messages, Pet messages and low-confidence decisions alone', async (t) => {
  let decision: RouteDecision = { target: 'pet:executor', confidence: 0.2 };
  const { studio, channel, channelId, dispatched, seen, events } = await routedStudio(() => decision);
  t.after(() => studio.shutdown());

  await channel.sendMessage(channelId, { body: 'Review this', mentions: [{ participantId: 'pet:reviewer' }] }, me);
  await channel.sendMessage(channelId, { body: 'From a Pet' }, { kind: 'pet', id: 'reviewer' });
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

test('without routing an unaddressed message wakes no Pet', async (t) => {
  const dispatched: Dispatched[] = [];
  const channel = createChannelPlugin({ httpRoute: false });
  const studio = await createStudio({ studioId: 'test', entryPetId: 'executor', plugins: [channel], pets: [fakePet('executor', dispatched)] });
  t.after(() => studio.shutdown());
  const { channel: { channelId } } = await channel.service.createChannel(me, { title: 'Quiet', pets: ['executor'] });
  await channel.sendMessage(channelId, { body: 'Who is handling #1003?' }, me);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(dispatched.length, 0);
});
