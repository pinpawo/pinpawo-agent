import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStudio, type StudioDispatchRequest } from '@pinpawo/studio';
import { parseStudioOperatorArgs, runStudioOperator } from '../../../packages/studio/src/studioOperatorCli';
import { createChannelPlugin, type ChannelInputsHook } from '@pinpawo-plugin/channel';
import { createStudioHttpPlugin } from '@pinpawo-plugin/studio-http';

const hash = (value: string) => createHash('sha256').update(value).digest('hex');
test('two users and two Pets share scoped history; a delegated client belongs to its user; CLI and revocation use real HTTP', async () => {
  const root = await mkdtemp(join(tmpdir(), 'channel-members-'));
  const calls: StudioDispatchRequest[] = [];
  let inputs!: ChannelInputsHook;
  const channel = createChannelPlugin({ databasePath: join(root, 'channels.sqlite'), operatorId: 'u1',
    users: [{ id: 'u1', label: 'Same name' }, { id: 'u2', label: 'Same name' }],
    inputUsers: { mappedSource: 'u1' },
    credentials: [{ userId: 'u1', tokenHash: hash('u1-test') }, { userId: 'u2', tokenHash: hash('u2-test') },
      { userId: 'u1', tokenHash: hash('agent-test'), actorId: 'external-client' }],
  });
  const http = createStudioHttpPlugin({ port: 0, authToken: 'admin-test-only-long' });
  const studio = await createStudio({ studioId: 'members', entryPetId: 'p1', plugins: [channel, http, { name: 'source-probe', toolkits: [], start: host => { host.hooks.contribute<ChannelInputsHook>('channel', 'inputs', value => { inputs = value; }); } }],
    pets: ['p1', 'p2'].map(petId => ({ registration: { petId, name: 'Same name' }, dispatch: {
      getQueueSnapshot: () => ({ state: 'open' as const, activeOperation: null, queuedConversations: 0, queuedDispatches: 0 }),
      onQueueChange: () => () => {}, onDispatchLifecycle: () => () => {},
      dispatch: async (request: StudioDispatchRequest) => { calls.push(request); },
    } })),
  });
  const base = `http://127.0.0.1:${http.address()!.port}`;
  const request = (token: string, route: string, body?: unknown) => fetch(base + route, { method: body ? 'POST' : 'GET',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const json = async (token: string, route: string, body?: unknown) => {
    const response = await request(token, route, body); assert.ok(response.ok, await response.clone().text()); return response.json() as Promise<any>;
  };
  try {
    const c = await json('u1-test', '/channels', { title: 'Shared', goal: 'Team', scope: 'Only this Channel' });
    const id = c.channelId;
    assert.equal((await request('u2-test', `/channels/context?channelId=${id}`)).status, 403);
    assert.deepEqual((await json('u2-test', '/channels')).channels, []);
    await writeFile(join(root, 'admin-token'), 'admin-test-only-long', { mode: 0o600 });
    await writeFile(join(root, 'member.json'), JSON.stringify({ kind: 'human', id: 'u2', active: true }));
    await runStudioOperator(parseStudioOperatorArgs(['channels', 'member', id, '--file', join(root, 'member.json'), '--studio-url', base, '--token-file', join(root, 'admin-token')])!, { writeOutput: () => {} });
    await assert.rejects(inputs.post(id, { author: { kind: 'bot', id: 'unknownSource' }, body: 'No owner', mentions: [] }), /explicit user mapping/);
    await assert.rejects(inputs.post(id, { author: { kind: 'bot', id: 'constructor' }, body: 'No owner', mentions: [] }), /explicit user mapping/);
    assert.equal((await request('admin-test-only-long', '/channels/members', { channelId: id, kind: 'human', id: ' u1 ', active: false })).status, 409);
    assert.equal((await request('u2-test', '/channels/members', { channelId: id, kind: 'human', id: 'u1', active: false })).status, 403);
    const participants = await json('u2-test', `/channels/participants?channelId=${id}`);
    assert.deepEqual(new Set(participants.participants.map((p: any) => p.participantId)), new Set(['human:u1', 'human:u2', 'pet:p1', 'pet:p2']));
    assert.equal(participants.viewerParticipantId, 'human:u2');
    assert.deepEqual(new Set(participants.participants.map((p: any) => p.kind)), new Set(['human', 'pet']));
    for (const body of [{ author: { kind: 'human', id: 'u2' } }, { actorId: 'someone' }]) {
      assert.equal((await request('agent-test', '/channels/messages', { channelId: id, body: 'forged', ...body })).status, 400);
    }
    assert.equal((await request('u2-test', '/events')).status, 401);
    assert.equal((await request('u2-test', '/dispatch', { petId: 'p1', request: 'bypass' })).status, 401);
    assert.equal((await request('', `/channels/context?channelId=${id}`)).status, 401);
    const agent = await json('agent-test', '/channels/messages', { channelId: id, body: '[@Old label](participant:pet:p1) and [@Other](participant:pet:p2)' });
    assert.deepEqual(agent.author, { kind: 'human', id: 'u1', actorId: 'external-client' });
    assert.equal(agent.deliveries.length, 2); assert.equal(calls.length, 2);
    const sent = await json('u2-test', '/channels/messages', { channelId: id, body: 'Thanks', replyTo: agent.messageId, mentions: [{ participantId: 'human:u1' }] });
    assert.deepEqual(sent.author, { kind: 'human', id: 'u2' });
    assert.equal(calls.length, 2, 'user addressing and replyTo do not execute Pets');
    assert.equal((await request('u2-test', '/channels/execute', { channelId: id, body: 'reply is a quote', replyTo: agent.messageId })).status, 409);
    assert.equal(calls.length, 2, 'execute also requires an explicit recipient after the main update');
    assert.equal((await request('u2-test', '/channels/messages', { channelId: id, body: 'unknown', mentions: [{ participantId: 'human:unknown' }] })).status, 409);
    const other = await json('u1-test', '/channels', { title: 'Private', goal: 'Other', scope: 'Other' });
    assert.equal((await request('u2-test', '/channels/messages', { channelId: id, body: 'cross', replyTo: other.channelId })).status, 409);
    await writeFile(join(root, 'u2-token'), 'u2-test\n', { mode: 0o600 });
    let output = '';
    await runStudioOperator(parseStudioOperatorArgs(['channels', 'participants', id, '--studio-url', base, '--token-file', join(root, 'u2-token')])!, { writeOutput: text => { output += text; } });
    assert.equal(JSON.parse(output).viewerParticipantId, 'human:u2');
    output = '';
    await runStudioOperator(parseStudioOperatorArgs(['channels', 'send', id, '--file', '-', '--studio-url', base, '--token-file', join(root, 'u2-token'), '--mention', 'pet:p1'])!,
      { readStdin: async () => 'CLI follow-up', writeOutput: text => { output += text; } });
    assert.equal(JSON.parse(output).author.id, 'u2'); assert.equal(calls.length, 3);
    const view = await json('u1-test', `/channels/context?channelId=${id}&limit=1`);
    assert.equal(view.viewerParticipantId, 'human:u1'); assert.equal(view.history.hasMore, true);
    const next = await json('u2-test', `/channels/context?channelId=${id}&after=${view.history.nextAfter}`);
    assert.equal(next.history.entries[0].messageId, agent.messageId);
    await json('admin-test-only-long', '/channels/members', { channelId: id, kind: 'pet', id: 'p2', active: false });
    assert.equal((await request('u1-test', '/channels/messages', { channelId: id, body: 'removed', mentions: [{ participantId: 'pet:p2' }] })).status, 409);
    await json('admin-test-only-long', '/channels/members', { channelId: id, kind: 'human', id: 'u2', active: false });
    for (const route of ['context', 'executions', 'interrupts', 'participants', 'members']) assert.equal((await request('u2-test', `/channels/${route}?channelId=${id}`)).status, 403);
    assert.equal((await request('u2-test', '/channels/messages', { channelId: id, body: 'revoked' })).status, 403);
    assert.equal((await json('u1-test', `/channels/context?channelId=${id}`)).history.entries.some((e: any) => e.messageId === sent.messageId), true);
  } finally { await studio.shutdown(); await rm(root, { recursive: true, force: true }); }
});

test('credential revocation on restart keeps user authors and membership without granting the client another identity', async () => {
  const root = await mkdtemp(join(tmpdir(), 'channel-credential-restart-'));
  const start = async (includeClient: boolean) => {
    const channel = createChannelPlugin({ databasePath: join(root, 'channel.sqlite'), users: [{ id: 'second', label: 'Second' }],
      credentials: includeClient ? [{ userId: 'second', actorId: 'client', tokenHash: hash('second-test-only') }] : [] });
    const http = createStudioHttpPlugin({ port: 0, authToken: 'restart-admin-test-only' });
    const studio = await createStudio({ studioId: 'restart-members', entryPetId: 'p1', plugins: [channel, http], pets: [{
      registration: { petId: 'p1', name: 'Pet' }, dispatch: {
        getQueueSnapshot: () => ({ state: 'open' as const, activeOperation: null, queuedConversations: 0, queuedDispatches: 0 }),
        onQueueChange: () => () => {}, onDispatchLifecycle: () => () => {}, dispatch: async () => {},
      },
    }] });
    return { channel, studio, base: `http://127.0.0.1:${http.address()!.port}` };
  };
  let runtime = await start(true);
  try {
    const c = runtime.channel.service.createChannel({ title: 'Restart', goal: 'Persist', scope: 'Fixture' }, { kind: 'human', id: 'studio-operator' });
    runtime.channel.service.setMember(c.channelId, { kind: 'human', id: 'second', active: true });
    const response = await fetch(runtime.base + '/channels/messages', { method: 'POST', headers: { Authorization: 'Bearer second-test-only', 'Content-Type': 'application/json' },
      body: JSON.stringify({ channelId: c.channelId, body: 'Before revocation' }) });
    assert.equal(response.status, 201); const message = await response.json() as any;
    await runtime.studio.shutdown(); runtime = await start(false);
    assert.equal((await fetch(runtime.base + '/channels/viewer', { headers: { Authorization: 'Bearer second-test-only' } })).status, 401);
    assert.deepEqual(runtime.channel.service.getMessage(c.channelId, message.messageId).author, { kind: 'human', id: 'second', actorId: 'client' });
    assert.equal(runtime.channel.service.listMembers(c.channelId).find(member => member.id === 'second')?.active, true);
  } finally { await runtime.studio.shutdown(); await rm(root, { recursive: true, force: true }); }
});
