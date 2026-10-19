import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createStudio } from '@pinpawo/studio';
import { createStudioHttpPlugin } from '@pinpawo-plugin/studio-http';
import {
  buildHostRuntimeConfig, createResidentPetHost, FileSaver,
  type PetInvocationScope,
} from 'pinpawo/host-runtime';
import { HostToolkitInventoryStore } from '../../../services/host/src/toolkits/toolkitInventory';
import { createTestModelProfiles } from '../../../services/host/src/testing/modelProfiles';
import {
  ChannelAccessError, createChannelPlugin, type ChannelDelivery, type ChannelMessage,
} from '@pinpawo-plugin/channel';
import { readChannelTestInput, readChannelTestTask } from '../../support/channelDispatchInput';

/** The local Host token's Studio client, as a Channel member. */
const me = { kind: 'human' as const, id: 'local' };

async function waitFor(done: () => boolean | Promise<boolean>) {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (await done()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('Timed out waiting for resident dispatch.');
}

type Dispatched = { request: string; session?: { id: string; create?: boolean }; scope?: PetInvocationScope };
const fakePet = (petId: string, dispatched: Dispatched[]) => ({
  registration: { petId, name: petId[0]!.toUpperCase() + petId.slice(1) }, dispatch: {
    getQueueSnapshot: () => ({ state: 'open' as const, activeOperation: null, queuedConversations: 0, queuedDispatches: 0 }),
    onQueueChange: () => () => {}, onDispatchLifecycle: () => () => {},
    dispatch: async (input: Dispatched) => { dispatched.push(input); },
  },
});

test('HTTP acts as the authenticated client: rejects spoofing and non-members, manages members and dispatches only addressed Pets', async () => {
  const dispatched: Dispatched[] = [];
  const channel = createChannelPlugin();
  const http = createStudioHttpPlugin({ port: 0, authToken: 'channel-test-token' });
  const studio = await createStudio({
    studioId: 'test', entryPetId: 'reviewer', plugins: [channel, http],
    pets: [fakePet('reviewer', dispatched), fakePet('writer', dispatched)],
  });
  const base = `http://127.0.0.1:${http.address()!.port}`;
  const headers = { Authorization: 'Bearer channel-test-token', 'Content-Type': 'application/json' };
  const post = (route: string, body: unknown) => fetch(base + route, { method: 'POST', headers, body: JSON.stringify(body) });
  const get = (route: string) => fetch(base + route, { headers });
  try {
    assert.equal((await fetch(base + '/channels')).status, 401);
    assert.equal((await fetch(base + '/channels', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status, 401);
    assert.equal((await post('/channels', { title: 'Old shape', goal: 'Long term', scope: 'Round one', pets: [] })).status, 400);
    assert.equal((await post('/channels', { title: 'No Pets named' })).status, 400);
    assert.equal((await post('/channels', { title: 'Unknown', pets: ['ghost'] })).status, 409);
    const created = await post('/channels', { title: 'Release', description: 'Ship 1.0', pets: ['reviewer'] });
    assert.equal(created.status, 201);
    const { channel: { channelId }, members } = await created.json() as { channel: { channelId: string }; members: Array<{ participantId: string }> };
    assert.deepEqual(members.map(member => member.participantId), ['human:local', 'pet:reviewer']);
    assert.equal(dispatched.length, 0);
    for (const forged of [
      { author: { kind: 'pet', id: 'reviewer' } },
      { source: { petId: 'reviewer', sessionId: 'forged', invocationId: 'forged' } },
      { scope: { namespace: 'channel', id: channelId } },
      { participantId: 'pet:reviewer' },
      { mentions: [{ petId: 'reviewer' }] },
    ]) assert.equal((await post('/channels/messages', { channelId, body: 'spoof', ...forged })).status, 400);
    assert.equal((await post('/channels/messages', { channelId, body: 'not here', mentions: [{ participantId: 'pet:writer' }] })).status, 409,
      'only current members can be addressed');
    const plain = await (await post('/channels/messages', { channelId, body: 'quoted @reviewer' })).json() as ChannelMessage & { deliveries: ChannelDelivery[] };
    assert.deepEqual(plain.author, { kind: 'human', id: 'local' });
    assert.deepEqual([plain.mentions, plain.deliveries], [[], []]);
    const reply = await post('/channels/messages', { channelId, body: 'Review this', replyTo: plain.messageId,
      mentions: [{ participantId: 'pet:reviewer' }], artifacts: [{ uri: 'repo:commit-a', version: 'a' }] });
    assert.equal(reply.status, 201);
    const { deliveries } = await reply.json() as { deliveries: ChannelDelivery[] };
    assert.deepEqual(deliveries.map(delivery => [delivery.participantId, delivery.state]), [['pet:reviewer', 'accepted']]);
    assert.deepEqual(dispatched.map(item => [item.session, item.scope]), [[{ id: deliveries[0]!.sessionId, create: true }, { namespace: 'channel', id: channelId }]]);
    const input = readChannelTestInput(dispatched[0]!.request);
    assert.deepEqual([input.author, input.replyTo?.messageId], [{ participantId: 'human:local', kind: 'human', label: 'Local' }, plain.messageId]);
    const context = await (await get(`/channels/context?channelId=${channelId}&limit=1`)).json() as {
      channel: { description: string }; members: unknown[]; messages: unknown[]; hasMore: boolean; hasEarlier: boolean; viewerParticipantId: string;
    };
    // The newest page: nothing after it, the earlier message before it.
    assert.deepEqual([context.channel.description, context.members.length, context.messages.length, context.hasMore, context.hasEarlier, context.viewerParticipantId],
      ['Ship 1.0', 2, 1, false, true, 'human:local']);
    assert.deepEqual((await (await get(`/channels/sessions?channelId=${channelId}`)).json() as { sessions: unknown[] }).sessions,
      [{ channelId, petId: 'reviewer', sessionId: deliveries[0]!.sessionId, registered: true }]);
    assert.equal((await (await post('/channels/update', { channelId, title: 'Release 1.0' })).json() as { title: string }).title, 'Release 1.0');
    for (const route of ['/channels/execute', '/channels/revisions', '/channels/participants', '/channels/executions', '/channels/interrupts']) {
      assert.equal((await get(route)).status, 404, route);
    }

    // A human member is a Studio client: unknown ids cannot join.
    assert.equal((await post('/channels/members', { channelId, kind: 'human', id: 'guest' })).status, 409);
    const { key: guestKey } = await (await post('/clients', { clientId: 'guest', label: 'Guest' })).json() as { key: string };
    const asGuest = { Authorization: `Bearer ${guestKey}`, 'Content-Type': 'application/json' };
    assert.equal((await fetch(base + `/channels/context?channelId=${channelId}`, { headers: asGuest })).status, 403, 'not a member yet');
    const guest = await post('/channels/members', { channelId, kind: 'human', id: 'guest' });
    assert.equal(guest.status, 201);
    assert.equal((await guest.json() as { participantId: string }).participantId, 'human:guest');
    assert.equal((await post('/channels/members', { channelId, kind: 'pet', id: 'writer' })).status, 201);
    assert.equal((await post('/channels/members', { channelId, kind: 'pet', id: 'ghost' })).status, 409);
    assert.equal((await post('/channels/members', { channelId, kind: 'bot', id: 'x' })).status, 400);
    assert.equal((await post('/channels/members/remove', { channelId, kind: 'pet', id: 'reviewer' })).status, 200);
    const listed = await (await get(`/channels/members?channelId=${channelId}`)).json() as { members: Array<{ participantId: string }> };
    assert.deepEqual(listed.members.map(member => member.participantId), ['human:local', 'human:guest', 'pet:writer']);
    assert.equal((await post('/channels/messages', { channelId, body: 'gone', mentions: [{ participantId: 'pet:reviewer' }] })).status, 409);
    const toHuman = await (await post('/channels/messages', { channelId, body: '[@guest](participant:human:guest) FYI' })).json() as { deliveries: ChannelDelivery[] };
    assert.deepEqual(toHuman.deliveries, [{ participantId: 'human:guest', state: 'delivered' }]);
    assert.equal(dispatched.length, 1, 'addressing a human dispatches nothing');

    // The guest reads and speaks as itself, and reaches nothing but Channel routes.
    const guestView = await (await fetch(base + `/channels/context?channelId=${channelId}`, { headers: asGuest })).json() as {
      viewerParticipantId: string; members: Array<{ participantId: string; label: string }>;
    };
    assert.equal(guestView.viewerParticipantId, 'human:guest');
    assert.deepEqual(guestView.members.map(member => member.label), ['Local', 'Guest', 'Writer']);
    const fromGuest = await (await fetch(base + '/channels/messages', { method: 'POST', headers: asGuest,
      body: JSON.stringify({ channelId, body: 'Thanks' }) })).json() as ChannelMessage;
    assert.deepEqual(fromGuest.author, { kind: 'human', id: 'guest' });
    for (const route of ['/events', '/clients', '/dispatch/queues']) assert.equal((await fetch(base + route, { headers: asGuest })).status, 403, route);
    assert.deepEqual(await (await fetch(base + '/me', { headers: asGuest })).json(), { clientId: 'guest', scope: 'client' });
    assert.equal((await fetch(base + '/pets', { headers: asGuest })).status, 200, 'a client reads the Pet directory to create Channels');
    const guestAll = await (await fetch(base + '/channels?all=true', { headers: asGuest })).json() as { channels: Array<{ channelId: string }> };
    assert.deepEqual(guestAll.channels.map(item => item.channelId), [channelId], 'all is for the local token only');
    await post('/clients/revoke', { clientId: 'guest' });
    assert.equal((await fetch(base + '/channels', { headers: asGuest })).status, 401);

    // A Channel the local client never joined is closed to its messages; the local token may still manage its members.
    const other = (await channel.service.createChannel({ kind: 'human', id: 'someone-else' }, { title: 'Private', pets: ['reviewer'] })).channel.channelId;
    const listing = await (await get('/channels')).json() as { channels: Array<{ channelId: string }>; viewerParticipantId: string };
    assert.deepEqual(listing.channels.map(item => item.channelId), [channelId]);
    const everything = await (await get('/channels?all=true')).json() as { channels: Array<{ channelId: string }> };
    assert.deepEqual(everything.channels.map(item => item.channelId), [channelId, other]);
    for (const route of ['context', 'sessions']) assert.equal((await get(`/channels/${route}?channelId=${other}`)).status, 403, route);
    for (const [route, body] of [
      ['/channels/messages', { body: 'let me in', mentions: [{ participantId: 'pet:reviewer' }] }],
      ['/channels/update', { title: 'Taken' }],
    ] as const) assert.equal((await post(route, { channelId: other, ...body })).status, 403, route);
    assert.equal((await get(`/channels/members?channelId=${other}`)).status, 200);
    assert.equal((await post('/channels/members/remove', { channelId: other, kind: 'human', id: 'someone-else' })).status, 409,
      'the last human member stays');
    assert.equal((await post('/channels/members', { channelId: other, kind: 'human', id: 'local' })).status, 201);
    assert.equal((await post('/channels/members/remove', { channelId: other, kind: 'human', id: 'someone-else' })).status, 200);
    assert.equal((await get(`/channels/context?channelId=${other}`)).status, 200, 'joined, so it reads');
    assert.equal((await get('/channels/context?channelId=missing')).status, 404);
    assert.equal(dispatched.length, 1);

    const sameInput = { channelId, body: 'Same text, two new messages', mentions: [{ participantId: 'pet:writer' }] };
    const independent = await Promise.all([post('/channels/messages', sameInput), post('/channels/messages', sameInput)]);
    assert.ok(independent.every(response => response.status === 201));
    const messages = await Promise.all(independent.map(response => response.json() as Promise<ChannelMessage>));
    assert.notEqual(messages[0]!.messageId, messages[1]!.messageId);
    assert.equal(dispatched.length, 3, 'independent messages have distinct identities; equal text is not a retry');
    assert.equal(new Set(dispatched.slice(1).map(item => item.session!.id)).size, 1);
  } finally { await studio.shutdown(); }
});

test('real resident queue binds tools to current Channel and Pet, rejects spoofing, non-members and metadata fallback', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'channel-resident-'));
  const runtimeConfig = buildHostRuntimeConfig(root);
  const channel = createChannelPlugin({ httpRoute: false });
  assert.deepEqual(channel.toolkits[0]!.tools.map((entry) => entry.tool.name), ['channel_read_context']);
  const read = channel.toolkits[0]!.tools[0]!.tool;
  const failures: unknown[] = [];
  const snapshots: Array<{ channel: { channelId: string; description?: string }; members: Array<{ participantId: string }> }> = [];
  const threads: string[] = [];
  let started = false;
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  const host = await createResidentPetHost({
    petId: 'executor', petName: 'Not the author ID', modelProfiles: createTestModelProfiles(),
    runtimeConfig, toolAuthorizationMode: 'full_access', autoAuthorizationSafetyLevel: 'strict',
    capabilities: [], toolkitInventory: new HostToolkitInventoryStore(),
    capabilityArtifactStore: {
      writeArtifact: async () => { throw new Error('unused'); }, readArtifact: async () => { throw new Error('unused'); },
      listArtifacts: async () => [], deleteThreadArtifacts: async () => {}, getDownloadUri: async (uri) => uri,
    },
    checkpointer: new FileSaver(runtimeConfig.checkpointPath), sessionStatePath: runtimeConfig.tuiSessionPath,
    graphService: { readThreadState: async () => ({ messages: [], pendingInterrupt: null, acceptsResume: false, currentPlan: null }) } as never,
    runAgentTurn: async ({ request, setup }) => {
      if (request.kind !== 'user_message') throw new Error('unexpected input');
      if (request.message === 'first') { started = true; await blocked; }
      try {
        threads.push(setup.input.threadId!);
        snapshots.push(JSON.parse(await read.invoke({}, { configurable: { channelId: 'spoof', petId: 'spoof' } }) as string));
      } catch (error) { failures.push(error); }
      return { status: 'completed', reply: 'done' };
    },
  });
  const studio = await createStudio({ studioId: 's', entryPetId: 'executor',
    pets: [{ registration: { petId: 'executor', name: 'Executor' }, dispatch: host.resident.dispatch }], plugins: [channel],
  });
  try {
    const owner = { kind: 'human', id: 'owner' } as const;
    const a = (await channel.service.createChannel(owner, { title: 'A', pets: ['executor'] })).channel.channelId;
    const b = (await channel.service.createChannel(owner, { title: 'B', description: 'B before', pets: ['executor'] })).channel.channelId;
    const outside = (await channel.service.createChannel(owner, { title: 'Not joined', pets: [] })).channel.channelId;
    await assert.rejects(read.invoke({}), /Host-admitted/);
    const scope: PetInvocationScope = { namespace: 'channel', id: a };
    await studio.dispatch({ petId: 'executor', request: 'first', scope });
    await waitFor(() => started);
    await studio.dispatch({ petId: 'executor', request: 'second', scope: { namespace: 'channel', id: b } });
    await studio.dispatch({ petId: 'executor', request: 'unscoped', metadata: { channelId: a } });
    await studio.dispatch({ petId: 'executor', request: 'not a member', scope: { namespace: 'channel', id: outside } });
    (scope as { id: string }).id = b;
    await channel.service.updateChannel(owner, b, { description: 'B revised while queued' });
    release();
    await waitFor(() => snapshots.length + failures.length === 4);
    assert.deepEqual(snapshots.map(item => item.channel.channelId), [a, b]);
    assert.equal(snapshots[1]?.channel.description, 'B revised while queued');
    assert.deepEqual(snapshots[0]?.members.map(member => member.participantId), ['human:owner', 'pet:executor']);
    assert.equal(new Set(threads).size, 1, 'same Session serves distinct Channel scopes');
    assert.equal(failures.length, 2);
    assert.match(String(failures[0]), /Host-admitted/);
    assert.ok(failures[1] instanceof ChannelAccessError, 'a Pet reads only Channels it belongs to');
    await assert.rejects(read.invoke({}), /Host-admitted/);
    for (const id of [a, b]) assert.equal((await channel.service.readContext(owner, id)).messages.length, 0);
  } finally { release(); await host.close(); await studio.shutdown(); await rm(root, { recursive: true, force: true }); }
});

test('a Pet message is its Channel session public reply, written once, handed off through the mention path; failures are only events', async () => {
  const dispatched: Dispatched[] = [];
  const channel = createChannelPlugin({ httpRoute: false });
  const studio = await createStudio({ studioId: 'pet-message', entryPetId: 'one', plugins: [channel],
    pets: [fakePet('one', dispatched), fakePet('two', dispatched)] });
  const events: Array<{ type: string; payload?: any }> = [];
  studio.subscribe(event => { events.push(event); });
  try {
    const operator = me;
    const id = (await channel.service.createChannel(operator, { title: 'Goal', pets: ['one', 'two'] })).channel.channelId;
    const { deliveries: [delivery] } = await channel.sendMessage(id, { body: 'Start', mentions: [{ participantId: 'pet:one' }] }, me);
    const sessionId = delivery!.sessionId!;
    const petMessages = async () => (await channel.service.readContext(operator, id)).messages.filter(message => message.author.kind === 'pet');
    const failures = () => events.filter(event => event.type === 'channel.message_failed').map(event => event.payload);
    const emit = (message: Record<string, unknown>, payload: Record<string, unknown> = {}) => studio.notify({
      source: 'resident-pet', type: 'dispatch.message', occurredAt: new Date().toISOString(),
      payload: { petId: 'one', invocationId: delivery!.invocationId, sessionId, scope: { namespace: 'channel', id }, message, ...payload },
    });
    const completed = (messageId: string, text: string) => ({ type: 'message.completed', messageId, role: 'assistant', text });
    const handoff = 'Over to [@Two](participant:pet:two).';
    emit({ type: 'message.tool_calls', messageId: 'tool-1', text: handoff, toolCalls: [{ id: 'c', name: 'plan_request', args: {} }] });
    emit({ type: 'tool_call.settled', messageId: 'tool-1', toolCallId: 'c', status: 'completed' });
    emit(completed('empty', '  '));
    emit(completed('reply-1', handoff));
    await waitFor(async () => (await petMessages()).length === 1 && dispatched.length === 2);
    assert.deepEqual((await petMessages()).map(message => [message.author, message.externalRef, message.body, message.mentions]),
      [[{ kind: 'pet', id: 'one' }, 'reply-1', handoff, [{ participantId: 'pet:two', label: 'Two' }]]]);
    const input = readChannelTestInput(dispatched[1]!.request);
    assert.deepEqual([input.author, input.messageId], [{ participantId: 'pet:one', kind: 'pet', label: 'One' }, (await petMessages())[0]!.messageId]);
    assert.deepEqual(dispatched[1]!.session, { id: (await channel.service.getSession(id, 'two'))!.sessionId, create: true });
    await waitFor(() => events.some(event => event.type === 'channel.delivery' && event.payload.participantId === 'pet:two'));
    assert.equal(events.find(event => event.type === 'channel.delivery' && event.payload.participantId === 'pet:two')!.payload.state, 'accepted');

    emit(completed('reply-1', handoff));
    emit(completed('reply-3', 'Not a Channel run.'), { scope: undefined });
    emit(completed('reply-2', 'Not from the bound session.'), { sessionId: 'one:forged' });
    await waitFor(() => failures().length === 1);
    await channel.service.removeMember(operator, id, { kind: 'pet', id: 'one' });
    emit(completed('reply-4', 'After leaving.'));
    await waitFor(() => failures().length === 2);
    assert.deepEqual(failures().map(payload => [payload.externalRef, payload.petId, payload.sessionId]),
      [['reply-2', 'one', 'one:forged'], ['reply-4', 'one', sessionId]]);
    assert.match(failures()[0].error, /session does not match/);
    assert.match(failures()[1].error, /not a member/);
    await channel.service.addMember(operator, id, { kind: 'pet', id: 'one' });
    channel.service.postMessage = async () => { throw new Error('disk unavailable'); };
    emit(completed('reply-5', 'Not saved.'));
    await waitFor(() => failures().length === 3);
    assert.equal(failures()[2].error, 'disk unavailable');
    assert.deepEqual((await petMessages()).map(message => message.externalRef), ['reply-1'], 'replays, tool calls and failed writes leave no message');
    assert.equal(dispatched.length, 2, 'a replayed reply hands off once');
  } finally { await studio.shutdown(); }
});

test('run sends a channel_task to a member Pet session without writing a Channel message', async () => {
  const dispatched: Dispatched[] = [];
  const channel = createChannelPlugin({ httpRoute: false });
  const studio = await createStudio({ studioId: 'run', entryPetId: 'one', plugins: [channel],
    pets: [fakePet('one', dispatched), fakePet('two', dispatched)] });
  try {
    const id = (await channel.service.createChannel(me, { title: 'Ops', pets: ['one'] })).channel.channelId;
    const origin = { kind: 'scheduler', id: 'nightly' } as const;
    const receipt = await channel.run(` ${id} `, 'one', 'Nightly check', origin, { idempotencyKey: 'nightly:1' });
    assert.equal(receipt.sessionId, (await channel.service.getSession(id, 'one'))!.sessionId);
    assert.deepEqual(await channel.run(id, 'one', 'Nightly check', origin, { idempotencyKey: 'nightly:1' }), receipt);
    await channel.run(id, 'one', 'Triggered check', { kind: 'trigger', id: 'external-request' });
    assert.deepEqual(dispatched.map(item => [item.session, item.scope]), [
      [{ id: receipt.sessionId, create: true }, { namespace: 'channel', id }],
      [{ id: receipt.sessionId }, { namespace: 'channel', id }],
    ]);
    assert.deepEqual(readChannelTestTask(dispatched[0]!.request), { type: 'channel_task', version: 1, channelId: id, origin, body: 'Nightly check' });
    assert.deepEqual(readChannelTestTask(dispatched[1]!.request).origin, { kind: 'trigger', id: 'external-request' });
    assert.deepEqual((await channel.service.readContext(me, id)).messages, []);
    await assert.rejects(channel.run(id, 'two', 'Not a member', origin), ChannelAccessError);
    await assert.rejects(channel.run(id, 'one', 'Bad origin', { kind: 'bot', id: 'x' } as never));
    await assert.rejects(channel.run(id, 'one', '   ', origin));
    assert.equal(dispatched.length, 2);
  } finally { await studio.shutdown(); }
});
