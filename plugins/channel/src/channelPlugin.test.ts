import assert from 'node:assert/strict';
import test from 'node:test';
import { createStudioStorage, type StudioDispatchRequest, type StudioEvent, type StudioEventInput, type StudioPluginContext } from '@pinpawo/studio-core';
import type { StudioHttpRoute, StudioHttpRoutesHook } from '@pinpawo-plugin/studio-http';
import { createChannelPlugin, type ChannelWorking } from './channelPlugin';
import { ChannelAccessError } from './channelService';

test('messages retain references and mentions without dispatching a Pet', async (t) => {
  const storage = createStudioStorage({ kind: 'sqlite', path: ':memory:' });
  t.after(() => storage.close());
  const dispatched: StudioDispatchRequest[] = [];
  const notified: StudioEventInput[] = [];
  const live: ReturnType<StudioPluginContext['listPets']> = [];
  const removeInstance = async (petId: string) => { const index = live.findIndex(pet => pet.petId === petId); if (index >= 0) live.splice(index, 1); };
  const plugin = createChannelPlugin({ httpRoute: false });
  const context = {
    dispatch: async (request: StudioDispatchRequest) => {
      dispatched.push(request);
      return { petId: request.petId, invocationId: `dispatch-${dispatched.length}` };
    },
    allocateSessionId: () => 'writer-session',
    registerContextProvider: () => () => undefined,
    notify: (event: StudioEventInput) => { notified.push(event); },
    subscribe: () => () => undefined,
    listPets: () => live,
    pets: { removeInstance, get: async (petId: string) => live.find(pet => pet.petId === petId) } as unknown as StudioPluginContext['pets'],
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
  assert.deepEqual(mentioned.message.deliverables, current);
  assert.equal(mentioned.message.replyTo, original.message.messageId);
  assert.deepEqual(mentioned.message.mentions.map(item => item.participantId), ['pet:writer']);
  assert.equal(dispatched.length, 0);

  const other = (await plugin.service.createChannel(owner, { title: 'Other', pets: [] })).channel.channelId;
  const otherMessage = (await plugin.sendMessage(other, { body: 'Elsewhere.', deliverables: current }, owner)).message;
  const messageEvents = notified.filter(event => event.type === 'channel.message.created');
  assert.deepEqual(messageEvents.map(event => event.topic), [channelId, channelId, other]);
  assert.deepEqual(messageEvents.map(event => (event.payload as { messageId: string }).messageId), [
    original.message.messageId, mentioned.message.messageId, otherMessage.messageId,
  ]);
  assert.ok(notified.filter(event => event.type !== 'channel.message.created').every(event => event.topic === undefined));
  await assert.rejects(plugin.sendMessage(channelId, { body: 'Wrong reply.', replyTo: otherMessage.messageId,
    mentions: [{ participantId: 'pet:writer' }],
  }, owner), /does not exist in this Channel/);
  await assert.rejects(plugin.sendMessage(channelId, { body: 'Former member cannot send.',
    mentions: [{ participantId: 'pet:writer' }], deliverables: current,
  }, former), ChannelAccessError);
  await assert.rejects(plugin.sendMessage(channelId, { body: 'Unknown target.',
    mentions: [{ participantId: 'pet:missing' }], deliverables: current,
  }, owner));
  assert.equal(dispatched.length, 0);
});

test('a Pet works in a Channel only while its run there is running, and context reads say so', async (t) => {
  const storage = createStudioStorage({ kind: 'sqlite', path: ':memory:' });
  t.after(() => storage.close());
  const notified: Array<{ type: string; payload?: unknown }> = [];
  const listeners: Array<(event: StudioEvent) => unknown> = [];
  const routes = new Map<string, StudioHttpRoute>();
  const live: ReturnType<StudioPluginContext['listPets']> = [];
  const removeInstance = async (petId: string) => { const index = live.findIndex(pet => pet.petId === petId); if (index >= 0) live.splice(index, 1); };
  const plugin = createChannelPlugin();
  const context: StudioPluginContext = {
    dispatch: async () => { throw new Error('not used'); },
    registerContextProvider: () => () => undefined,
    allocateSessionId: () => 'unused',
    notify: (event) => { notified.push(event); },
    subscribe: (listener) => { listeners.push(listener); return () => undefined; },
    listPets: () => live,
    pets: { removeInstance, get: async (petId: string) => live.find(pet => pet.petId === petId) } as unknown as StudioPluginContext['pets'],
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

test('an accepted Pet output survives a terminal event during a registry lookup', async (t) => {
  const storage = createStudioStorage({ kind: 'sqlite', path: ':memory:' });
  t.after(() => storage.close());
  const notified: Array<{ type: string; payload?: unknown }> = [];
  const listeners: Array<(event: StudioEvent) => unknown> = [];
  const live: ReturnType<StudioPluginContext['listPets']> = [];
  let releaseLookup!: () => void;
  let lookupStarted!: () => void;
  const gate = new Promise<void>(resolve => { releaseLookup = resolve; });
  const started = new Promise<void>(resolve => { lookupStarted = resolve; });
  let delayLookup = false;
  let closed = false;
  let ownerOverride: string | undefined;
  const plugin = createChannelPlugin({ httpRoute: false });
  const context = {
    dispatch: async () => { throw new Error('not used'); },
    registerContextProvider: () => () => undefined,
    allocateSessionId: () => 'writer-session',
    notify: (event: { type: string; payload?: unknown }) => { notified.push(event); },
    subscribe: (listener: (event: StudioEvent) => unknown) => { listeners.push(listener); return () => undefined; },
    listPets: () => closed ? [] : live,
    pets: {
      removeInstance: async () => undefined,
      get: async (petId: string) => {
        if (delayLookup) { delayLookup = false; lookupStarted(); await gate; }
        const pet = live.find(item => item.petId === petId);
        return pet && (closed ? { ...pet, channelId: ownerOverride ?? pet.channelId, closedAt: '2026-11-05T00:00:00Z' } : pet);
      },
    },
    clients: { get: async (clientId: string) => ({ clientId, label: clientId }) },
    storage: { dialect: 'sqlite', open: (migrations: Parameters<typeof storage.open>[1]) => storage.open('channel', migrations) },
    hooks: { expose: () => () => undefined },
  } as unknown as StudioPluginContext;
  await plugin.start!(context);
  t.after(() => plugin.stop?.());
  const owner = { kind: 'human' as const, id: 'owner' };
  const channelId = (await plugin.service.createChannel(owner, { title: 'Race', pets: [] })).channel.channelId;
  live.push({ petId: 'writer', name: 'Writer', definitionId: 'writer', channelId, createdAt: new Date().toISOString() });
  const binding = await plugin.service.reserveSession(channelId, 'writer', () => 'writer-session');
  await plugin.service.confirmSession(binding);
  const event = (type: string, invocationId: string, sessionId = binding.sessionId): StudioEvent => ({
    eventId: `${invocationId}:${type}`, type: `dispatch.${type}`, source: 'resident-pet', occurredAt: '2026-11-05T00:00:00Z',
    payload: { invocationId, petId: 'writer', sessionId, scope: { namespace: 'channel', id: channelId },
      ...(type === 'message' ? { message: { type: 'message.completed', messageId: invocationId, text: 'Finished.' } } : {}) },
  });
  const emit = async (value: StudioEvent) => { for (const listener of listeners) await listener(value); };
  await emit(event('running', 'accepted'));
  delayLookup = true;
  const output = emit(event('message', 'accepted'));
  await started;
  closed = true;
  await emit(event('completed', 'accepted'));
  releaseLookup();
  await output;
  assert.deepEqual((await plugin.service.readContext(owner, channelId)).messages.map(message => message.externalRef), ['accepted']);

  // A stale invocation, mismatched binding, or changed owner cannot gain authority.
  await emit(event('message', 'not-accepted'));
  await emit(event('running', 'wrong-session'));
  await emit(event('message', 'wrong-session', 'different-session'));
  ownerOverride = 'other-channel';
  await emit(event('running', 'wrong-owner'));
  await emit(event('message', 'wrong-owner'));
  assert.deepEqual((await plugin.service.readContext(owner, channelId)).messages.map(message => message.externalRef), ['accepted']);
  const failures = notified.filter(item => item.type === 'channel.message_failed').map(item => (item.payload as { externalRef: string }).externalRef);
  assert.deepEqual(failures, ['not-accepted', 'wrong-session', 'wrong-owner']);
});
