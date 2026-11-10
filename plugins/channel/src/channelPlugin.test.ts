import assert from 'node:assert/strict';
import test from 'node:test';
import { createStudioStorage, type StudioDispatchRequest, type StudioEvent, type StudioPluginContext } from '@pinpawo/studio-core';
import type { StudioHttpRoute, StudioHttpRoutesHook } from '@pinpawo-plugin/studio-http';
import { createChannelPlugin, type ChannelWorking } from './channelPlugin';
import { ChannelAccessError } from './channelService';
import { readChannelTestInput } from '../../../tests/support/channelDispatchInput';

test('mentions dispatch explicit current and reply attachments without guessing earlier or textual references', async (t) => {
  const storage = createStudioStorage({ kind: 'sqlite', path: ':memory:' });
  t.after(() => storage.close());
  const dispatched: StudioDispatchRequest[] = [];
  const live: ReturnType<StudioPluginContext['listPets']> = [];
  const closeInstance = async (petId: string) => { const index = live.findIndex(pet => pet.petId === petId); if (index >= 0) live.splice(index, 1); };
  const plugin = createChannelPlugin({ httpRoute: false });
  const context = {
    dispatch: async (request: StudioDispatchRequest) => {
      dispatched.push(request);
      return { petId: request.petId, invocationId: `dispatch-${dispatched.length}` };
    },
    allocateSessionId: () => 'writer-session',
    registerContextProvider: () => () => undefined,
    notify: () => undefined,
    subscribe: () => () => undefined,
    listPets: () => live,
    pets: { closeInstance, get: async (petId: string) => live.find(pet => pet.petId === petId) } as unknown as StudioPluginContext['pets'],
    clients: { get: async (clientId: string) => ({ clientId, label: clientId }) },
    storage: { dialect: 'sqlite', open: (migrations: Parameters<typeof storage.open>[1]) => storage.open('channel', migrations) },
    hooks: { expose: () => () => undefined },
    models: { resolve: () => { throw new Error('No model is used by this dispatch test.'); } },
  } as unknown as StudioPluginContext;
  await plugin.start!(context);
  t.after(() => plugin.stop?.());

  const owner = { kind: 'human' as const, id: 'owner' };
  const former = { kind: 'human' as const, id: 'former' };
  const channelId = (await plugin.service.createChannel(owner, { title: 'Images', pets: [] })).channel.channelId;
  live.push({ petId: 'writer', name: 'Writer', definitionId: 'writer', channelId, createdAt: new Date().toISOString() });
  await plugin.service.addMember(owner, channelId, former);
  const original = await plugin.sendMessage(channelId, { body: 'Previously shared images.', deliverables: [
    { uri: 'artifact://workspace/shared.png', title: 'Old shared title' },
    { uri: 'artifact://workspace/reply.png', title: 'Reply image' },
  ] }, former);
  assert.equal(dispatched.length, 0);
  await plugin.service.removeMember(owner, channelId, former);

  const current = [{ uri: 'artifact://workspace/current.png', title: 'Current image' },
    { uri: 'artifact://workspace/shared.png', title: 'Current shared title' }];
  const mentioned = await plugin.sendMessage(channelId, {
    body: 'Inspect the current image and the replied images.', replyTo: original.message.messageId,
    mentions: [{ participantId: 'pet:writer' }], deliverables: current,
  }, owner);
  assert.equal(mentioned.deliveries[0]!.state, 'accepted');
  assert.deepEqual(dispatched[0]!.attachments, [...current, { uri: 'artifact://workspace/reply.png', title: 'Reply image' }]);
  assert.deepEqual(dispatched[0]!.scope, { namespace: 'channel', id: channelId });
  const envelope = readChannelTestInput(dispatched[0]!.request);
  assert.equal(envelope.messageId, mentioned.message.messageId);
  assert.equal(envelope.body, mentioned.message.body);
  assert.equal(envelope.replyTo?.messageId, original.message.messageId);
  assert.deepEqual(envelope.replyTo?.author, { participantId: 'human:former', kind: 'human' });

  await plugin.sendMessage(channelId, { body: 'Only this image.', mentions: [{ participantId: 'pet:writer' }],
    deliverables: [current[0]],
  }, owner);
  assert.deepEqual(dispatched[1]!.attachments, [current[0]], 'an unquoted earlier image is not added');
  await plugin.sendMessage(channelId, { body: 'Text link artifact://workspace/not-an-attachment.png',
    mentions: [{ participantId: 'pet:writer' }],
  }, owner);
  assert.equal(Object.hasOwn(dispatched[2]!, 'attachments'), false);

  const other = (await plugin.service.createChannel(owner, { title: 'Other', pets: [] })).channel.channelId;
  const otherMessage = (await plugin.sendMessage(other, { body: 'Elsewhere.', deliverables: current }, owner)).message;
  await assert.rejects(plugin.sendMessage(channelId, { body: 'Wrong reply.', replyTo: otherMessage.messageId,
    mentions: [{ participantId: 'pet:writer' }],
  }, owner), /does not exist in this Channel/);
  await assert.rejects(plugin.sendMessage(channelId, { body: 'Former member cannot send.',
    mentions: [{ participantId: 'pet:writer' }], deliverables: current,
  }, former), ChannelAccessError);
  await assert.rejects(plugin.sendMessage(channelId, { body: 'Unknown target.',
    mentions: [{ participantId: 'pet:missing' }], deliverables: current,
  }, owner));
  assert.equal(dispatched.length, 3);
});

test('a Pet works in a Channel only while its run there is running, and context reads say so', async (t) => {
  const storage = createStudioStorage({ kind: 'sqlite', path: ':memory:' });
  t.after(() => storage.close());
  const notified: Array<{ type: string; payload?: unknown }> = [];
  const listeners: Array<(event: StudioEvent) => unknown> = [];
  const routes = new Map<string, StudioHttpRoute>();
  const live: ReturnType<StudioPluginContext['listPets']> = [];
  const closeInstance = async (petId: string) => { const index = live.findIndex(pet => pet.petId === petId); if (index >= 0) live.splice(index, 1); };
  const plugin = createChannelPlugin();
  const context: StudioPluginContext = {
    dispatch: async () => { throw new Error('not used'); },
    registerContextProvider: () => () => undefined,
    allocateSessionId: () => 'unused',
    notify: (event) => { notified.push(event); },
    subscribe: (listener) => { listeners.push(listener); return () => undefined; },
    listPets: () => live,
    pets: { closeInstance, get: async (petId: string) => live.find(pet => pet.petId === petId) } as unknown as StudioPluginContext['pets'],
    listDispatchQueues: () => [],
    petSessions: {
      snapshot: async () => { throw new Error('not used'); },
      observe: async () => { throw new Error('not used'); },
      review: async () => { throw new Error('not used'); },
    },
    hooks: {
      expose: () => () => undefined,
      contribute: ((_plugin: string, _hook: string, contribution: (hook: StudioHttpRoutesHook) => () => void) => contribution({
        register: (route) => { routes.set(`${route.method} ${route.path}`, route); return () => undefined; },
      })) as StudioPluginContext['hooks']['contribute'],
    },
    storage: { dialect: 'sqlite', open: (migrations) => storage.open('channel', migrations) },
    clients: { get: async (clientId: string) => ({ clientId, label: clientId }) } as unknown as StudioPluginContext['clients'],
    models: { resolve: () => { throw new Error('not used'); } },
  };
  await plugin.start!(context);
  t.after(() => plugin.stop?.());

  const owner = { kind: 'human' as const, id: 'local' };
  const { channel: { channelId } } = await plugin.service.createChannel(owner, { title: 'Release', pets: [] });
  const other = (await plugin.service.createChannel(owner, { title: 'Other', pets: [] })).channel.channelId;
  live.push({ petId: 'writer', name: 'Writer', definitionId: 'writer', channelId, createdAt: new Date().toISOString() },
    { petId: 'writer-other', name: 'Writer', definitionId: 'writer', channelId: other, createdAt: new Date().toISOString() });
  const protectedChannel = (await plugin.service.createChannel(owner, { title: 'Protected', prompt: 'Original', pets: [] }, { studio: true })).channel.channelId;
  await plugin.service.addMember(owner, protectedChannel, { kind: 'human', id: 'guest' });
  const update = (clientId: string, scope: 'studio' | 'client', patch: Record<string, unknown>) => routes.get('POST /channels/update')!.handle({
    url: new URL('http://studio/channels/update'), headers: {}, readText: async () => '',
    readJson: async () => ({ channelId: protectedChannel, ...patch }), principal: { clientId, scope },
  });
  assert.equal((await update('guest', 'client', { prompt: 'Forged' })).status, 403);
  assert.equal((await update('local', 'client', { prompt: 'Forged by creator' })).status, 403);
  assert.equal((await update('guest', 'client', { title: 'Allowed' })).status ?? 200, 200);
  assert.equal((await update('admin', 'client', { prompt: 'Forged' })).status, 403);
  assert.equal((await update('admin', 'studio', { prompt: 'Recovered' })).status ?? 200, 200);
  assert.equal((await plugin.service.readContext(owner, protectedChannel)).channel.prompt, 'Recovered');
  let at = 0;
  const lifecycle = async (state: string, invocationId: string, petId = 'writer', scope: unknown = { namespace: 'channel', id: channelId }) => {
    const event: StudioEvent = {
      eventId: `${invocationId}:${state}`, type: `dispatch.${state}`, source: 'resident-pet',
      occurredAt: new Date(Date.UTC(2026, 9, 28, 0, 0, at++)).toISOString(),
      payload: { invocationId, petId, request: 'r', scope },
    };
    for (const listener of listeners) await listener(event);
  };
  const working = async (id = channelId) => {
    const result = await routes.get('GET /channels/context')!.handle({
      url: new URL(`http://studio/channels/context?channelId=${id}`), headers: {},
      readText: async () => '', readJson: async () => null, principal: { clientId: 'local', scope: 'studio' },
    });
    assert.equal(result.kind, 'json');
    return (result.body as { working: ChannelWorking[] }).working;
  };
  const changes = () => notified.filter(event => event.type === 'channel.working').map(event => event.payload);

  await lifecycle('queued', 'a');
  assert.deepEqual(await working(), []);
  await lifecycle('running', 'a');
  // A run elsewhere, or one without a Channel scope, says nothing about this Channel.
  await lifecycle('running', 'b', 'writer-other', { namespace: 'channel', id: other });
  await lifecycle('running', 'c', 'writer', null);
  assert.deepEqual(await working(), [{ participantId: 'pet:writer', since: '2026-10-28T00:00:01.000Z' }]);
  assert.deepEqual(await working(other), [{ participantId: 'pet:writer-other', since: '2026-10-28T00:00:02.000Z' }]);
  // A reply mid-run does not end the run; a review wait does, and resuming works again.
  await lifecycle('message', 'a');
  assert.equal((await working()).length, 1);
  await lifecycle('waiting', 'a');
  assert.deepEqual(await working(), []);
  await lifecycle('running', 'a');
  await lifecycle('completed', 'a');
  assert.deepEqual(await working(), []);
  // A Pet that is not a member is not shown even while it runs in the Channel's scope.
  await lifecycle('running', 'd', 'reviewer');
  assert.deepEqual(await working(), []);

  assert.deepEqual(changes(), [
    { channelId, participantId: 'pet:writer', working: true },
    { channelId: other, participantId: 'pet:writer-other', working: true },
    { channelId, participantId: 'pet:writer', working: false },
    { channelId, participantId: 'pet:writer', working: true },
    { channelId, participantId: 'pet:writer', working: false },
    { channelId, participantId: 'pet:reviewer', working: true },
  ]);

  const binding = await plugin.service.reserveSession(channelId, 'writer', () => 'writer-session');
  await plugin.service.confirmSession(binding);
  const deliverables = [{ uri: 'artifact://workspace/session/report/report.pdf', title: 'Report' }];
  const reply = async (messageId: string, refs: unknown) => {
    for (const listener of listeners) await listener({
      eventId: messageId, type: 'dispatch.message', source: 'resident-pet', occurredAt: '2026-11-05T00:00:00Z',
      payload: { petId: 'writer', invocationId: messageId, sessionId: binding.sessionId, scope: { namespace: 'channel', id: channelId },
        message: { type: 'message.completed', messageId, text: 'Ready.', deliverables: refs } },
    });
  };
  await reply('valid-reply', deliverables);
  const saved = (await plugin.service.readContext(owner, channelId)).messages;
  assert.equal(saved.length, 1);
  assert.deepEqual(saved[0]!.deliverables, deliverables);
  await reply('invalid-reply', [{ uri: 4 }]);
  assert.equal((await plugin.service.readContext(owner, channelId)).messages.length, 1);
  assert.ok(notified.some(event => event.type === 'channel.message_failed'
    && (event.payload as { externalRef: string }).externalRef === 'invalid-reply'));
});
