import assert from 'node:assert/strict';
import test from 'node:test';
import { createStudio, type StudioPetRuntime } from '@pinpawo/studio-core';
import { createChannelPlugin } from '@pinpawo-plugin/channel';
import type { PetDispatchLifecycleEvent } from 'pinpawo/host-runtime';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
async function waitFor(predicate: () => boolean) {
  for (let i = 0; i < 500; i++) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 2)); }
  throw new Error('Timed out waiting for delayed Channel outcome.');
}
const human = { kind: 'human' as const, id: 'local' };
function runtime(close = async () => {}): StudioPetRuntime {
  return { close, dispatch: {
    getQueueSnapshot: () => ({ state: 'open', activeOperation: null, queuedConversations: 0, queuedDispatches: 0 }),
    onQueueChange: () => () => {}, onDispatchLifecycle: () => () => {}, dispatch: async () => {},
  } };
}

for (const delay of ['router', 'session'] as const) {
  test(`a delayed ${delay} decision cannot start new work after the source Pet is removed`, async t => {
    const entered = deferred(), release = deferred();
    const channel = createChannelPlugin({ httpRoute: false, ...(delay === 'router' ? {
      routing: { enabled: true }, routeDecider: async () => { entered.resolve(); await release.promise; return { target: 'pet:b', confidence: 1 }; },
    } : {}) });
    let emit: ((event: PetDispatchLifecycleEvent) => void) | undefined;
    let targetRuns = 0, failed = false;
    const studio = await createStudio({ studioId: 'late-source', plugins: [channel],
      definitions: [{ definitionId: 'shared', name: 'Shared' }], assemblePet: async pet => {
        const value = runtime();
        if (pet.petId === 'a') value.dispatch.onDispatchLifecycle = listener => { emit = listener; return () => {}; };
        else value.dispatch.dispatch = async () => { targetRuns++; };
        return value;
      },
    });
    t.after(async () => { release.resolve(); await studio.shutdown(); });
    studio.subscribe(event => { if (event.type === 'channel.delivery' && (event.payload as { state?: string }).state === 'failed') failed = true; });
    const channelId = (await channel.service.createChannel(human, { title: 'Owner' })).channel.channelId;
    for (const petId of ['a', 'b']) await studio.pets.create({ petId, definitionId: 'shared', name: petId, channelId });
    const sessionId = (await channel.service.reserveSession(channelId, 'a', () => 'a:00000001')).sessionId;
    if (delay === 'session') {
      const reserve = channel.service.reserveSession.bind(channel.service);
      channel.service.reserveSession = async (...args) => {
        if (args[1] === 'b') { entered.resolve(); await release.promise; }
        return reserve(...args);
      };
    }
    emit!({ state: 'running', dispatchId: 'admitted', request: 'work', sessionId, scope: { namespace: 'channel', id: channelId } });
    emit!({ state: 'message', dispatchId: 'admitted', request: 'work', sessionId, scope: { namespace: 'channel', id: channelId },
      message: { type: 'message.completed', messageId: 'last-output', role: 'assistant', text: delay === 'router' ? 'Please consider this result.' : '[@B](participant:pet:b) Please consider this result.' } });
    await entered.promise;
    await studio.pets.removeInstance('a', { confirmStop: true });
    release.resolve();
    await waitFor(() => failed);
    assert.equal(targetRuns, 0);
    assert.equal((await channel.service.readContext(human, channelId)).messages.length, 1, 'retained history still receives the final reply');
  });
}

test('canonical Channel removal works and a concurrent Pet add cannot write phantom membership', async t => {
  const channel = createChannelPlugin({ httpRoute: false });
  const studio = await createStudio({ studioId: 'member-race', plugins: [channel],
    definitions: [{ definitionId: 'shared', name: 'Shared' }], assemblePet: async () => runtime(),
  });
  const entered = deferred(), release = deferred();
  t.after(async () => { release.resolve(); await studio.shutdown(); });
  const channelId = (await channel.service.createChannel(human, { title: 'Owner' })).channel.channelId;
  await studio.pets.create({ petId: 'a', definitionId: 'shared', name: 'A', channelId });
  const store = channel.service.store;
  const transaction = store.transaction.bind(store);
  store.transaction = async work => { entered.resolve(); await release.promise; return transaction(work); };
  const adding = channel.service.addMember(human, ` ${channelId} `, { kind: 'pet', id: 'a' });
  const refused = assert.rejects(adding, /not an instance/);
  await entered.promise;
  await channel.service.removeMember(human, ` \t${channelId}\n `, { kind: 'pet', id: 'a' }, { confirmStop: true });
  release.resolve();
  await refused;
  assert.ok((await studio.pets.get('a'))?.removedAt);
  assert.ok((await store.listMembers(channelId)).every(member => member.kind === 'human'));
  assert.ok(!(await channel.service.members(channelId)).some(member => member.kind === 'pet'));
});


test('a handoff already admitted before source removal may still settle', async t => {
  const entered = deferred(), release = deferred();
  const channel = createChannelPlugin({ httpRoute: false });
  let targetRuns = 0;
  const studio = await createStudio({ studioId: 'admitted-source', plugins: [channel],
    definitions: [{ definitionId: 'shared', name: 'Shared' }], assemblePet: async pet => {
      const value = runtime();
      if (pet.petId === 'b') value.dispatch.dispatch = async () => { targetRuns++; entered.resolve(); await release.promise; };
      return value;
    },
  });
  t.after(async () => { release.resolve(); await studio.shutdown(); });
  const channelId = (await channel.service.createChannel(human, { title: 'Owner' })).channel.channelId;
  for (const petId of ['a', 'b']) await studio.pets.create({ petId, definitionId: 'shared', name: petId, channelId });
  const sending = channel.sendMessage(channelId, { body: 'Admitted handoff.', mentions: [{ participantId: 'pet:b' }] }, { kind: 'pet', id: 'a' });
  await entered.promise;
  await studio.pets.removeInstance('a', { confirmStop: true });
  release.resolve();
  const result = await sending;
  assert.equal(result.deliveries[0]?.state, 'accepted');
  assert.equal(targetRuns, 1);
  assert.ok(studio.listPets().some(pet => pet.petId === 'b'));
});
