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

test('an accepted Pet output survives close and a terminal event while its write is pending', async t => {
  const entered = deferred(), release = deferred();
  const channel = createChannelPlugin({ httpRoute: false });
  let emit: ((event: PetDispatchLifecycleEvent) => void) | undefined;
  const studio = await createStudio({ studioId: 'late-output', plugins: [channel],
    definitions: [{ definitionId: 'shared', name: 'Shared' }], assemblePet: async () => {
      const value = runtime();
      value.dispatch.onDispatchLifecycle = listener => { emit = listener; return () => {}; };
      return value;
    },
  });
  t.after(async () => { release.resolve(); await studio.shutdown(); });
  const channelId = (await channel.service.createChannel(human, { title: 'Owner' })).channel.channelId;
  await studio.pets.create({ petId: 'a', definitionId: 'shared', name: 'A', channelId });
  const sessionId = (await channel.service.reserveSession(channelId, 'a', () => 'a:00000001')).sessionId;
  const get = studio.pets.get.bind(studio.pets);
  let delay = true;
  studio.pets.get = async petId => {
    if (delay && petId === 'a') { delay = false; entered.resolve(); await release.promise; }
    return get(petId);
  };
  const scope = { namespace: 'channel' as const, id: channelId };
  emit!({ state: 'running', dispatchId: 'admitted', request: 'work', sessionId, scope });
  emit!({ state: 'message', dispatchId: 'admitted', request: 'work', sessionId, scope,
    message: { type: 'message.completed', messageId: 'last-output', role: 'assistant', text: 'Final result.' } });
  await entered.promise;
  await studio.pets.closeInstance('a', { confirmStop: true });
  emit!({ state: 'completed', dispatchId: 'admitted', request: 'work', sessionId, scope });
  release.resolve();
  let messages = (await channel.service.readContext(human, channelId)).messages;
  for (let i = 0; i < 500 && !messages.length; i++) {
    await new Promise(resolve => setTimeout(resolve, 2));
    messages = (await channel.service.readContext(human, channelId)).messages;
  }
  assert.deepEqual(messages.map(message => [message.author.id, message.externalRef]), [['a', 'last-output']]);
});

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


test('a Pet message remains in history after the author is removed and does not dispatch its mention', async t => {
  const channel = createChannelPlugin({ httpRoute: false });
  let targetRuns = 0;
  const studio = await createStudio({ studioId: 'recorded-source', plugins: [channel],
    definitions: [{ definitionId: 'shared', name: 'Shared' }], assemblePet: async pet => {
      const value = runtime();
      if (pet.petId === 'b') value.dispatch.dispatch = async () => { targetRuns++; };
      return value;
    },
  });
  t.after(async () => { await studio.shutdown(); });
  const channelId = (await channel.service.createChannel(human, { title: 'Owner' })).channel.channelId;
  for (const petId of ['a', 'b']) await studio.pets.create({ petId, definitionId: 'shared', name: petId, channelId });
  const { message } = await channel.sendMessage(channelId, { body: 'Recorded handoff.', mentions: [{ participantId: 'pet:b' }] }, { kind: 'pet', id: 'a' });
  await studio.pets.removeInstance('a', { confirmStop: true });
  assert.deepEqual(await channel.service.getMessage(channelId, message.messageId), message);
  assert.equal(targetRuns, 0);
  assert.ok(studio.listPets().some(pet => pet.petId === 'b'));
});
