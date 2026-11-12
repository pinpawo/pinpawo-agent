import assert from 'node:assert/strict';
import test from 'node:test';
import { prepareStudio } from '../../../packages/studio/src/createStudio';
import { bindPetHeadChannel, createPetHead, type HeadDecision, type HeadInput } from '../../../packages/studio/src/host/petHead';
import { createChannelPlugin } from '../../../plugins/channel/src/channelPlugin';

const human = { kind: 'human' as const, id: 'local' };
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
async function waitFor(predicate: () => boolean) {
  for (let attempt = 0; attempt < 1000; attempt++) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error('Timed out waiting for Timeline delivery.');
}

test('live Timeline subscriptions isolate slow instances and discard queued and offline events on reactivation', async () => {
  const channel = createChannelPlugin({ httpRoute: false });
  const seen: Record<string, string[]> = { slow: [], fast: [], elsewhere: [] };
  const dispatches: string[] = [];
  const held = deferred<HeadDecision>();
  let inFlightSignal: AbortSignal | undefined;
  const decide = async ({ pet, message }: HeadInput, signal: AbortSignal): Promise<HeadDecision> => {
    seen[pet.petId]!.push(message.body);
    if (pet.petId === 'slow' && message.body === 'first') {
      inFlightSignal = signal;
      return held.promise;
    }
    return { action: 'ignore' };
  };
  const prepared = prepareStudio({
    studioId: 'head-subscription-fifo', definitions: [{ definitionId: 'worker', name: 'Worker' }], plugins: [channel],
    assemblePet: async registration => ({
      dispatch: {
        getQueueSnapshot: () => ({ state: 'open', activeOperation: null, queuedConversations: 0, queuedDispatches: 0 }),
        onQueueChange: () => () => {}, onDispatchLifecycle: () => () => {},
        dispatch: async () => { dispatches.push(registration.petId); },
      }, close: async () => {},
    }),
    subscribePetTimeline: ({ registration }, signal) => {
      const bound = bindPetHeadChannel(registration.channelId, channel.head, (handler, filter) => {
        assert.deepEqual(filter, { source: 'channel', topic: registration.channelId });
        return prepared.studio.subscribe(handler, filter);
      });
      const handle = createPetHead({ pet: registration, channel: bound, decide });
      return bound.subscribe(message => handle(message, signal));
    },
  });
  const studio = prepared.studio;
  try {
    await prepared.activatePlugins();
    const { channel: { channelId } } = await channel.service.createChannel(human, { title: 'FIFO', pets: [] });
    for (const petId of ['slow', 'fast']) {
      await studio.pets.create({ petId, definitionId: 'worker', name: petId, channelId });
    }
    const otherId = (await channel.service.createChannel(human, { title: 'Elsewhere', pets: [] })).channel.channelId;
    await studio.pets.create({ petId: 'elsewhere', definitionId: 'worker', name: 'Elsewhere', channelId: otherId });
    const post = async (body: string) => channel.service.postMessage(human, channelId, { body });
    await post('first');
    await waitFor(() => seen.slow!.includes('first') && seen.fast!.includes('first'));
    await post('queued');
    await channel.service.postMessage(human, otherId, { body: 'another Channel' });
    await waitFor(() => seen.fast!.includes('queued') && seen.elsewhere!.includes('another Channel'));
    assert.deepEqual(seen.slow, ['first'], 'a slow subscriber handles its own events in order');
    assert.deepEqual(seen.fast, ['first', 'queued'], 'another instance is not blocked');

    await studio.pets.closeInstance('slow', { confirmStop: true });
    assert.equal(inFlightSignal?.aborted, true);
    held.resolve({ action: 'dispatch', text: 'late task' });
    await post('offline');
    await waitFor(() => seen.fast!.includes('offline'));
    await studio.pets.reopenInstance('slow');
    await post('after reopen');
    await waitFor(() => seen.slow!.includes('after reopen') && seen.fast!.includes('after reopen'));
    assert.deepEqual(seen.slow, ['first', 'after reopen'], 'queued and offline events are not replayed');
    assert.deepEqual(seen.fast, ['first', 'queued', 'offline', 'after reopen']);
    assert.deepEqual(seen.elsewhere, ['another Channel'], 'each Channel has an independent live subscription');
    assert.deepEqual(dispatches, [], 'cancelled in-flight work cannot dispatch after Close');
  } finally {
    held.resolve({ action: 'ignore' });
    await studio.shutdown();
  }
});
