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
import { createChannelPlugin, type ChannelMessage } from '@pinpawo-plugin/channel';

async function waitFor(done: () => boolean) {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (done()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('Timed out waiting for resident dispatch.');
}

test('HTTP authenticates operators, preserves replies, validates mentions and never dispatches', async () => {
  let dispatches = 0;
  const channel = createChannelPlugin();
  const http = createStudioHttpPlugin({ port: 0, authToken: 'channel-test-token' });
  const studio = await createStudio({
    studioId: 'test', entryPetId: 'reviewer', plugins: [channel, http],
    pets: [{ registration: { petId: 'reviewer', name: 'Reviewer' }, dispatch: {
      getQueueSnapshot: () => ({ state: 'open', activeOperation: null, queuedConversations: 0, queuedDispatches: 0 }),
      onQueueChange: () => () => {}, onDispatchLifecycle: () => () => {},
      dispatch: async () => { dispatches++; },
    } }],
  });
  const base = `http://127.0.0.1:${http.address()!.port}`;
  const post = (route: string, body: unknown) => fetch(base + route, {
    method: 'POST', headers: { Authorization: 'Bearer channel-test-token', 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  try {
    assert.equal((await fetch(base + '/channels')).status, 401);
    assert.equal((await fetch(base + '/channels', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status, 401);
    const created = await post('/channels', { title: 'Goal', goal: 'Long term', scope: 'Round one' });
    assert.equal(created.status, 201);
    const { channelId, sequence } = await created.json() as { channelId: string; sequence: number };
    assert.equal(dispatches, 0);
    assert.equal((await post('/channels/messages', { channelId, body: 'spoof', author: { kind: 'pet', id: 'reviewer' } })).status, 400);
    assert.equal((await post('/channels/messages', { channelId, body: 'unknown', mentions: [{ petId: 'missing' }] })).status, 409);
    const plain = await (await post('/channels/messages', { channelId, body: 'quoted @reviewer' })).json() as ChannelMessage;
    assert.deepEqual(plain.author, { kind: 'human', id: 'studio-operator' });
    assert.deepEqual(plain.mentions, []);
    const reply = await post('/channels/messages', { channelId, body: 'Review this', replyTo: plain.messageId, mentions: [{ petId: 'reviewer' }], artifacts: [{ uri: 'repo:commit-a', version: 'a' }] });
    assert.equal(reply.status, 201);
    assert.equal((await post('/channels/revisions', { channelId, title: 'Goal', goal: 'Long term', scope: 'Round two', reason: 'User direction', expectedRevision: sequence })).status, 201);
    assert.equal((await post('/channels/revisions', { channelId, title: 'Goal', goal: 'Long term', scope: 'Stale', reason: 'Stale', expectedRevision: sequence })).status, 409);
    const context = await fetch(base + `/channels/context?channelId=${channelId}&limit=2`, { headers: { Authorization: 'Bearer channel-test-token' } });
    const result = await context.json() as { channel: { scope: string }; history: { hasMore: boolean; entries: unknown[] } };
    assert.equal(result.channel.scope, 'Round two');
    assert.equal(result.history.entries.length, 2);
    assert.equal(result.history.hasMore, true);
    assert.equal(dispatches, 0, 'neither creation nor explicit mentions dispatch in this foundation slice');
    assert.equal((await fetch(base + '/channels/execute', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ channelId, petId: 'reviewer', body: 'start' }) })).status, 401);
    assert.equal((await post('/channels/execute', { channelId, petId: 'reviewer', body: 'start', sessionId: 'forged' })).status, 400);
    const execution = await post('/channels/execute', { channelId, petId: 'reviewer', body: 'start explicitly' });
    assert.equal(execution.status, 202);
    assert.equal(dispatches, 1);
    assert.ok(channel.service.getBinding(channelId, 'reviewer')?.registered);
  } finally { await studio.shutdown(); }
});

test('real resident queue binds tools to current Channel and Pet, rejects spoofing and metadata fallback', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'channel-resident-'));
  const runtimeConfig = buildHostRuntimeConfig(root);
  const channel = createChannelPlugin({ httpRoute: false });
  const send = channel.toolkits[0]!.tools.find((entry) => entry.tool.name === 'channel_send_message')!.tool;
  const read = channel.toolkits[0]!.tools.find((entry) => entry.tool.name === 'channel_read_context')!.tool;
  const outputs: ChannelMessage[] = [];
  const failures: unknown[] = [];
  const snapshots: Array<{ channel: { channelId: string; scope: string } }> = [];
  const threads: string[] = [];
  let started = false;
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  const host = await createResidentPetHost({
    petId: 'executor', petName: 'Not the author ID', modelProfiles: createTestModelProfiles(),
    runtimeConfig, globalReviewPolicyMode: 'full_access', autoAuthorizationSafetyLevel: 'strict',
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
        snapshots.push(JSON.parse(await read.invoke({}) as string));
        await assert.rejects(send.invoke({ body: 'spoof', author: { kind: 'human', id: 'owner' } }));
        await assert.rejects(send.invoke({ body: 'cross-channel', channelId: 'other' }));
        outputs.push(JSON.parse(await send.invoke({ body: request.message }, {
          configurable: { petId: 'spoof', channelId: 'spoof' },
        }) as string));
      } catch (error) { failures.push(error); }
      return { status: 'completed', reply: 'done' };
    },
  });
  const studio = await createStudio({ studioId: 's', entryPetId: 'executor',
    pets: [{ registration: { petId: 'executor', name: 'Executor' }, dispatch: host.resident.dispatch }], plugins: [channel],
  });
  try {
    const author = { kind: 'human', id: 'owner' } as const;
    const a = channel.service.createChannel({ title: 'A', goal: 'A goal', scope: 'A scope' }, author);
    const b = channel.service.createChannel({ title: 'B', goal: 'B goal', scope: 'B scope' }, author);
    await assert.rejects(send.invoke({ body: 'outside', mentions: [] }), /Host-admitted/);
    const scope: PetInvocationScope = { namespace: 'channel', id: a.channelId };
    await studio.dispatch({ petId: 'executor', request: 'first', scope });
    await waitFor(() => started);
    await studio.dispatch({ petId: 'executor', request: 'second', scope: { namespace: 'channel', id: b.channelId } });
    await studio.dispatch({ petId: 'executor', request: 'unscoped', metadata: { channelId: a.channelId } });
    (scope as { id: string }).id = b.channelId;
    channel.service.reviseChannel(b.channelId, { title: 'B', goal: 'B goal', scope: 'B revised while queued', expectedRevision: b.sequence, reason: 'New input' }, author);
    release();
    await waitFor(() => outputs.length + failures.length === 3);
    assert.deepEqual(outputs.map((message) => [message.channelId, message.author]), [
      [a.channelId, { kind: 'pet', id: 'executor' }], [b.channelId, { kind: 'pet', id: 'executor' }],
    ]);
    assert.equal(snapshots[1]?.channel.scope, 'B revised while queued');
    assert.equal(new Set(threads).size, 1, 'same Session serves distinct Channel scopes');
    assert.equal(failures.length, 1);
    assert.match(String(failures[0]), /Host-admitted/);
    await assert.rejects(read.invoke({}), /Host-admitted/);
    assert.equal(channel.service.readHistory(a.channelId).entries.length, 2);
    assert.equal(channel.service.readHistory(b.channelId).entries.length, 3);
  } finally { release(); await host.close(); await studio.shutdown(); await rm(root, { recursive: true, force: true }); }
});
