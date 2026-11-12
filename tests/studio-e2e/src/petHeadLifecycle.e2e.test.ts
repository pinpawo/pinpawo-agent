import assert from 'node:assert/strict';
import test from 'node:test';
import { prepareStudio } from '../../../packages/studio/src/createStudio';
import { bindPetHeadChannel, createPetHead, type HeadDecision, type HeadInput } from '../../../packages/studio/src/host/petHead';
import { createChannelPlugin } from '../../../plugins/channel/src/channelPlugin';

const human = { kind: 'human' as const, id: 'local' };
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
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
  throw new Error('Timed out waiting for a Head decision.');
}

test('real Channel events follow Pet close, reopen and remove without replay or late dispatch', async () => {
  const channel = createChannelPlugin({ httpRoute: false });
  const observed: string[] = [];
  const dispatched: unknown[] = [];
  const pending = new Map<string, ReturnType<typeof deferred<HeadDecision>>>();
  const decide = async ({ message }: HeadInput): Promise<HeadDecision> => {
    observed.push(message.body);
    const wait = pending.get(message.body);
    return wait ? wait.promise : { action: 'ignore' };
  };
  const prepared = prepareStudio({
    studioId: 'head-lifecycle', definitions: [{ definitionId: 'worker', name: 'Worker' }], plugins: [channel],
    assemblePet: async () => ({
      dispatch: {
        getQueueSnapshot: () => ({ state: 'open', activeOperation: null, queuedConversations: 0, queuedDispatches: 0 }),
        onQueueChange: () => () => {}, onDispatchLifecycle: () => () => {},
        dispatch: async request => { dispatched.push(request); },
      }, close: async () => {},
    }),
    subscribePetTimeline: ({ registration }, signal) => {
      const bound = bindPetHeadChannel(registration.channelId, channel.head, prepared.studio.subscribe);
      const handle = createPetHead({ pet: registration, channel: bound, decide });
      return bound.subscribe(message => handle(message, signal));
    },
  });
  const studio = prepared.studio;
  try {
    await prepared.activatePlugins();
    const { channel: { channelId } } = await channel.service.createChannel(human, { title: 'Lifecycle', pets: [] });
    await studio.pets.create({ petId: 'worker', definitionId: 'worker', name: 'Worker', channelId });
    const post = async (body: string) => channel.service.postMessage(human, channelId, { body });
    const first = deferred<HeadDecision>();
    pending.set('held before close', first);
    await post('held before close');
    await waitFor(() => observed.includes('held before close'));
    await studio.pets.closeInstance('worker', { confirmStop: true });
    first.resolve({ action: 'dispatch', text: 'late task' });
    await post('while closed');
    await studio.pets.reopenInstance('worker');
    await post('after reopen');
    await waitFor(() => observed.includes('after reopen'));
    assert.deepEqual(observed, ['held before close', 'after reopen']);
    assert.equal(dispatched.length, 0, 'a decision finishing after Close cannot dispatch');
    const second = deferred<HeadDecision>();
    pending.set('held before remove', second);
    await post('held before remove');
    await waitFor(() => observed.includes('held before remove'));
    await studio.pets.removeInstance('worker', { confirmStop: true });
    second.resolve({ action: 'dispatch', text: 'late task after remove' });
    await post('after remove');
    await tick();
    assert.deepEqual(observed, ['held before close', 'after reopen', 'held before remove']);
    assert.equal(dispatched.length, 0, 'a decision finishing after Remove cannot dispatch');
  } finally { await studio.shutdown(); }
});

test('duplicate Pet externalRef emits only one event to another live Head', async () => {
  const channel = createChannelPlugin({ httpRoute: false });
  const observed: string[] = [];
  const prepared = prepareStudio({
    studioId: 'head-external-ref', definitions: [{ definitionId: 'worker', name: 'Worker' }], plugins: [channel],
    assemblePet: async () => ({
      dispatch: {
        getQueueSnapshot: () => ({ state: 'open', activeOperation: null, queuedConversations: 0, queuedDispatches: 0 }),
        onQueueChange: () => () => {}, onDispatchLifecycle: () => () => {}, dispatch: async () => {},
      }, close: async () => {},
    }),
    subscribePetTimeline: ({ registration }, signal) => {
      const bound = bindPetHeadChannel(registration.channelId, channel.head, prepared.studio.subscribe);
      const handle = createPetHead({ pet: registration, channel: bound,
        decide: async ({ pet, message }) => { if (pet.petId === 'observer') observed.push(message.body); return { action: 'ignore' }; },
      });
      return bound.subscribe(message => handle(message, signal));
    },
  });
  const studio = prepared.studio;
  try {
    await prepared.activatePlugins();
    const { channel: { channelId } } = await channel.service.createChannel(human, { title: 'Deduplication', pets: [] });
    for (const petId of ['source', 'observer']) await studio.pets.create({ petId, definitionId: 'worker', name: petId, channelId });
    const source = { kind: 'pet' as const, id: 'source' };
    const first = await channel.service.postMessage(source, channelId, { body: 'first output' }, { externalRef: 'same-output' });
    const duplicate = await channel.service.postMessage(source, channelId, { body: 'duplicate output' }, { externalRef: 'same-output' });
    assert.equal(first.created, true);
    assert.equal(duplicate.created, false);
    assert.equal(duplicate.message.messageId, first.message.messageId);
    await channel.service.postMessage(human, channelId, { body: 'barrier' });
    await waitFor(() => observed.includes('barrier'));
    assert.deepEqual(observed, ['first output', 'barrier']);
  } finally { await studio.shutdown(); }
});

test('a live Head writes a reply to the Timeline and dispatches source attachments through Host admission', async () => {
  const channel = createChannelPlugin({ httpRoute: false });
  const observed: string[] = [];
  const dispatched: Array<{ request: string; attachments?: unknown; scope?: unknown; session?: unknown }> = [];
  let triggerInput: HeadInput | undefined;
  const prepared = prepareStudio({
    studioId: 'head-delivery', definitions: [{ definitionId: 'worker', name: 'Worker' }], plugins: [channel],
    assemblePet: async () => ({
      dispatch: {
        getQueueSnapshot: () => ({ state: 'open', activeOperation: null, queuedConversations: 0, queuedDispatches: 0 }),
        onQueueChange: () => () => {}, onDispatchLifecycle: () => () => {},
        dispatch: async request => { dispatched.push(request); },
      }, close: async () => {},
    }),
    subscribePetTimeline: ({ registration }, signal) => {
      const bound = bindPetHeadChannel(registration.channelId, channel.head, prepared.studio.subscribe);
      const handle = createPetHead({ pet: registration, channel: bound,
        decide: async (input) => {
          const { message } = input;
          observed.push(message.body);
          if (message.body === 'inspect attachment') triggerInput = input;
          if (message.body === 'short question') return { action: 'reply', text: 'Short answer' };
          if (message.body === 'inspect attachment') return { action: 'dispatch', text: 'Inspect the attachment' };
          return { action: 'ignore' };
        },
      });
      return bound.subscribe(message => handle(message, signal));
    },
  });
  const studio = prepared.studio;
  try {
    await prepared.activatePlugins();
    const { channel: { channelId } } = await channel.service.createChannel(human, { title: 'Delivery', pets: [] });
    await studio.pets.create({ petId: 'worker', definitionId: 'worker', name: 'Worker', channelId });
    const question = await channel.service.postMessage(human, channelId, { body: 'short question' });
    await waitFor(() => observed.includes('short question'));
    let messages = (await channel.service.readContext(human, channelId)).messages;
    for (let attempt = 0; !messages.some(message => message.body === 'Short answer') && attempt < 1000; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 5));
      messages = (await channel.service.readContext(human, channelId)).messages;
    }
    const reply = messages.find(message => message.body === 'Short answer');
    assert.ok(reply);
    assert.deepEqual(reply.author, { kind: 'pet', id: 'worker' });
    assert.equal(reply.replyTo, question.message.messageId);
    await studio.pets.closeInstance('worker', { confirmStop: true });
    const referencedAttachments = [{ uri: 'https://example.com/older.png', title: 'Older' }];
    const referenced = await channel.service.postMessage(human, channelId, { body: 'older source', deliverables: referencedAttachments });
    for (let index = 0; index < 51; index++) await channel.service.postMessage(human, channelId, { body: `offline ${index}` });
    await studio.pets.reopenInstance('worker');
    const attachments = [{ uri: 'https://example.com/source.png', title: 'Source' }];
    await channel.service.postMessage(human, channelId, { body: 'inspect attachment', replyTo: referenced.message.messageId, deliverables: attachments });
    await waitFor(() => dispatched.length === 1);
    assert.deepEqual(dispatched[0]!.attachments, [...attachments, ...referencedAttachments]);
    assert.equal(triggerInput?.context.messages.some(message => message.messageId === referenced.message.messageId), false);
    assert.deepEqual(triggerInput?.context.referencedMessage, referenced.message, 'an explicit older reply remains available outside the context window');
    assert.ok(dispatched[0]!.request.includes(referenced.message.messageId), 'dispatch preserves the referenced source');
    assert.deepEqual(dispatched[0]!.scope, { namespace: 'channel', id: channelId });
    assert.ok(dispatched[0]!.session, 'admission uses the Channel session');
    assert.deepEqual(observed, ['short question', 'inspect attachment'], 'own reply does not trigger the Head');
  } finally { await studio.shutdown(); }
});
