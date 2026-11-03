import assert from 'node:assert/strict';
import test from 'node:test';
import { createStudioStorage, type StudioEvent, type StudioPluginContext } from '@pinpawo/studio-core';
import type { StudioHttpRoute, StudioHttpRoutesHook } from '@pinpawo-plugin/studio-http';
import { createChannelPlugin, type ChannelWorking } from './channelPlugin';

test('a Pet works in a Channel only while its run there is running, and context reads say so', async (t) => {
  const storage = createStudioStorage({ kind: 'sqlite', path: ':memory:' });
  t.after(() => storage.close());
  const notified: Array<{ type: string; payload?: unknown }> = [];
  const listeners: Array<(event: StudioEvent) => unknown> = [];
  const routes = new Map<string, StudioHttpRoute>();
  const plugin = createChannelPlugin();
  const context: StudioPluginContext = {
    dispatch: async () => { throw new Error('not used'); },
    registerContextProvider: () => () => undefined,
    allocateSessionId: () => 'unused',
    notify: (event) => { notified.push(event); },
    subscribe: (listener) => { listeners.push(listener); return () => undefined; },
    listPets: () => ['writer', 'reviewer'].map(petId => ({ petId, name: petId, definitionId: petId })),
    pets: {} as StudioPluginContext['pets'],
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
  const { channel: { channelId } } = await plugin.service.createChannel(owner, { title: 'Release', pets: ['writer'] });
  const other = (await plugin.service.createChannel(owner, { title: 'Other', pets: ['writer'] })).channel.channelId;
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
  await lifecycle('running', 'b', 'writer', { namespace: 'channel', id: other });
  await lifecycle('running', 'c', 'writer', null);
  assert.deepEqual(await working(), [{ participantId: 'pet:writer', since: '2026-10-28T00:00:01.000Z' }]);
  assert.deepEqual(await working(other), [{ participantId: 'pet:writer', since: '2026-10-28T00:00:02.000Z' }]);
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
    { channelId: other, participantId: 'pet:writer', working: true },
    { channelId, participantId: 'pet:writer', working: false },
    { channelId, participantId: 'pet:writer', working: true },
    { channelId, participantId: 'pet:writer', working: false },
    { channelId, participantId: 'pet:reviewer', working: true },
  ]);
});

test('Pet replies keep boundary references and report invalid Channel references without saving a message', async (t) => {
  const storage = createStudioStorage({ kind: 'sqlite', path: ':memory:' });
  t.after(() => storage.close());
  const notified: Array<{ type: string; payload?: unknown }> = [];
  const listeners: Array<(event: StudioEvent) => unknown> = [];
  const plugin = createChannelPlugin({ httpRoute: false });
  const context: StudioPluginContext = {
    dispatch: async () => { throw new Error('not used'); },
    registerContextProvider: () => () => undefined,
    allocateSessionId: () => 'unused',
    notify: (event) => { notified.push(event); },
    subscribe: (listener) => { listeners.push(listener); return () => undefined; },
    listPets: () => [{ petId: 'writer', name: 'Writer', definitionId: 'writer' }],
    pets: {} as StudioPluginContext['pets'],
    listDispatchQueues: () => [],
    petSessions: {
      snapshot: async () => { throw new Error('not used'); },
      observe: async () => { throw new Error('not used'); },
      review: async () => { throw new Error('not used'); },
    },
    hooks: { expose: () => () => undefined, contribute: () => () => undefined },
    storage: { dialect: 'sqlite', open: (migrations) => storage.open('channel', migrations) },
    clients: { get: async (clientId: string) => ({ clientId, label: clientId }) } as unknown as StudioPluginContext['clients'],
    models: { resolve: () => { throw new Error('not used'); } },
  };
  await plugin.start!(context);
  t.after(() => plugin.stop?.());
  const owner = { kind: 'human' as const, id: 'local' };
  const { channel: { channelId } } = await plugin.service.createChannel(owner, { title: 'Reports', pets: ['writer'] });
  const sessionId = 'writer:reports';
  await plugin.service.reserveSession(channelId, 'writer', () => sessionId);
  const emit = async (messageId: string, deliverables?: unknown) => {
    const event: StudioEvent = {
      eventId: messageId, type: 'dispatch.message', source: 'resident-pet', occurredAt: new Date().toISOString(),
      payload: {
        invocationId: 'writer:run', petId: 'writer', sessionId, scope: { namespace: 'channel', id: channelId },
        message: { type: 'message.completed', messageId, text: 'Ready.', ...(deliverables === undefined ? {} : { deliverables }) },
      },
    };
    for (const listener of listeners) await listener(event);
  };
  const deliverables = Array.from({ length: 100 }, (_, index) => ({
    uri: index === 0 ? ` ${'u'.repeat(4094)} ` : `repo:report-${index}`,
    title: 'T'.repeat(500),
    metadata: { index },
  }));
  await emit('boundary', deliverables);
  await emit('ordinary');
  const messages = (await plugin.service.readContext(owner, channelId)).messages;
  assert.equal(messages.length, 2);
  assert.deepEqual(messages[0]?.deliverables, deliverables);
  assert.deepEqual(messages[1]?.deliverables, []);
  const invalid = [
    [...deliverables, { uri: 'repo:extra', title: 'Extra', metadata: { index: 100 } }],
    [{ uri: ` ${'u'.repeat(4095)} ` }],
    [{ uri: 'repo:title', title: 'T'.repeat(501) }],
    [{ uri: 'repo:malformed', title: 1 }],
  ];
  for (const [index, value] of invalid.entries()) {
    await emit(`invalid-${index}`, value);
    assert.deepEqual((await plugin.service.readContext(owner, channelId)).messages, messages);
  }
  const failures = notified.filter(event => event.type === 'channel.message_failed').map(event => event.payload as {
    channelId: string; petId: string; sessionId: string; externalRef: string; error: string;
  });
  assert.deepEqual(failures.map(failure => failure.externalRef), invalid.map((_, index) => `invalid-${index}`));
  for (const failure of failures) {
    assert.equal(failure.channelId, channelId);
    assert.equal(failure.petId, 'writer');
    assert.equal(failure.sessionId, sessionId);
    assert.equal(typeof failure.error, 'string');
    assert.ok(failure.error.length > 0);
  }
});
