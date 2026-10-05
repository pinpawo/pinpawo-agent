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

test('HTTP authenticates operators, preserves notes and dispatches only explicitly addressed requests', async () => {
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
    for (const forged of [
      { source: { petId: 'reviewer', sessionId: 'forged', invocationId: 'forged' } },
      { scope: { namespace: 'channel', id: channelId } },
      { participantId: 'pet:reviewer' },
    ]) assert.equal((await post('/channels/messages', { channelId, body: 'spoof', ...forged })).status, 400);
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
    assert.equal(dispatches, 1, 'the addressed message dispatches; plain quoted labels and creation do not');
    assert.equal((await fetch(base + '/channels/execute', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ channelId, petId: 'reviewer', body: 'start' }) })).status, 401);
    assert.equal((await post('/channels/execute', { channelId, petId: 'reviewer', body: 'start', sessionId: 'forged' })).status, 400);
    const execution = await post('/channels/execute', { channelId, petId: 'reviewer', body: 'start explicitly' });
    assert.equal(execution.status, 202);
    assert.equal(dispatches, 2);
    assert.ok(channel.service.getBinding(channelId, 'reviewer')?.registered);
    const sameInput = { channelId, body: 'Same text, two new messages', mentions: [{ participantId: 'pet:reviewer' }] };
    const independent = await Promise.all([post('/channels/messages', sameInput), post('/channels/messages', sameInput)]);
    assert.ok(independent.every(response => response.status === 201));
    const messages = await Promise.all(independent.map(response => response.json() as Promise<ChannelMessage>));
    assert.notEqual(messages[0]!.messageId, messages[1]!.messageId);
    assert.equal(dispatches, 4, 'independent messages have distinct identities; equal text is not an execution retry');
  } finally { await studio.shutdown(); }
});

test('real resident queue binds tools to current Channel and Pet, rejects spoofing and metadata fallback', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'channel-resident-'));
  const runtimeConfig = buildHostRuntimeConfig(root);
  const channel = createChannelPlugin({ httpRoute: false });
  assert.ok(!channel.toolkits[0]!.tools.some((entry) => entry.tool.name === 'channel_send_message'));
  const read = channel.toolkits[0]!.tools.find((entry) => entry.tool.name === 'channel_read_context')!.tool;
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
        snapshots.push(JSON.parse(await read.invoke({}, { configurable: { channelId: 'spoof', petId: 'spoof' } }) as string));
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
    await assert.rejects(read.invoke({}), /Host-admitted/);
    const scope: PetInvocationScope = { namespace: 'channel', id: a.channelId };
    await studio.dispatch({ petId: 'executor', request: 'first', scope });
    await waitFor(() => started);
    await studio.dispatch({ petId: 'executor', request: 'second', scope: { namespace: 'channel', id: b.channelId } });
    await studio.dispatch({ petId: 'executor', request: 'unscoped', metadata: { channelId: a.channelId } });
    (scope as { id: string }).id = b.channelId;
    channel.service.reviseChannel(b.channelId, { title: 'B', goal: 'B goal', scope: 'B revised while queued', expectedRevision: b.sequence, reason: 'New input' }, author);
    release();
    await waitFor(() => snapshots.length + failures.length === 3);
    assert.deepEqual(snapshots.map(item => item.channel.channelId), [a.channelId, b.channelId]);
    assert.equal(snapshots[1]?.channel.scope, 'B revised while queued');
    assert.equal(new Set(threads).size, 1, 'same Session serves distinct Channel scopes');
    assert.equal(failures.length, 1);
    assert.match(String(failures[0]), /Host-admitted/);
    await assert.rejects(read.invoke({}), /Host-admitted/);
    assert.equal(channel.service.readHistory(a.channelId).entries.length, 1);
    assert.equal(channel.service.readHistory(b.channelId).entries.length, 2);
  } finally { release(); await host.close(); await studio.shutdown(); await rm(root, { recursive: true, force: true }); }
});

test('storage failure is observable and interrupt history is operator-only, read-only HTTP', async () => {
  const channel = createChannelPlugin();
  const http = createStudioHttpPlugin({ port: 0, authToken: 'notification-test' });
  const studio = await createStudio({ studioId: 'notification', entryPetId: 'one', plugins: [channel, http], pets: [{
    registration: { petId: 'one', name: 'One' }, dispatch: {
      getQueueSnapshot: () => ({ state: 'open', activeOperation: null, queuedConversations: 0, queuedDispatches: 0 }),
      onQueueChange: () => () => {}, onDispatchLifecycle: () => () => {}, dispatch: async () => {},
    },
  }] });
  const events: Array<{ type: string; payload?: unknown }> = [];
  studio.subscribe(event => { events.push(event); });
  const base = `http://127.0.0.1:${http.address()!.port}`;
  const headers = { Authorization: 'Bearer notification-test' };
  try {
    const id = channel.service.createChannel({ title: 'Goal', goal: 'Long term', scope: 'Round' }, { kind: 'human', id: 'owner' }).channelId;
    const binding = channel.service.reserveBinding(id, 'one', () => 'one:12345678');
    const source = { petId: 'one', sessionId: binding.sessionId, invocationId: 'waiting' };
    const pendingInterrupt = { interruptId: 'i', payload: { kind: 'human_review', interactions: [{
      interactionId: 'review', schemaVersion: 2, view: { kind: 'plain', body: 'Approve?' },
      options: [{ id: 'approve', label: 'Approve', batchSubmission: 'immediate' }],
    }] } };
    studio.notify({ source: 'resident-pet', type: 'dispatch.waiting', occurredAt: new Date().toISOString(),
      payload: { ...source, scope: { namespace: 'channel', id }, pendingInterrupt } });
    await waitFor(() => channel.service.readInterruptNotifications(id).notifications.length === 1);
    assert.equal((await fetch(`${base}/channels/interrupts?channelId=${id}`)).status, 401);
    const response = await fetch(`${base}/channels/interrupts?channelId=${id}`, { headers });
    assert.equal(response.status, 200);
    const page = await response.json() as { notifications: Array<{ pendingInterrupt: unknown; source: unknown }> };
    assert.deepEqual(page.notifications[0]?.pendingInterrupt, pendingInterrupt);
    assert.deepEqual(page.notifications[0]?.source, source);
    assert.equal((await fetch(`${base}/channels/interrupts?channelId=${id}`, { method: 'POST', headers })).status, 405);
    const context = await (await fetch(`${base}/channels/context?channelId=${id}`, { headers })).json();
    assert.ok(!JSON.stringify(context).includes('pendingInterrupt'));
    studio.notify({ source: 'resident-pet', type: 'dispatch.failed', occurredAt: new Date().toISOString(),
      payload: { ...source, invocationId: 'provider-failure', scope: { namespace: 'channel', id }, error: 'Provider rejected request (403).' } });
    await waitFor(() => channel.service.readExecutions(id).executions.some(item => item.state === 'failed'));
    assert.equal((await fetch(`${base}/channels/executions?channelId=${id}`)).status, 401);
    const executionResponse = await fetch(`${base}/channels/executions?channelId=${id}`, { headers });
    assert.equal(executionResponse.status, 200);
    const executionPage = await executionResponse.json() as { executions: Array<{ state: string; error?: string; sessionId: string }> };
    assert.equal(executionPage.executions.find(item => item.state === 'failed')?.error, 'Provider rejected request (403).');
    assert.ok(executionPage.executions.every(item => item.sessionId === binding.sessionId));
    assert.equal((await fetch(`${base}/channels/executions?channelId=${id}`, { method: 'POST', headers })).status, 405);
    channel.service.recordOutput = () => { throw new Error('disk unavailable'); };
    studio.notify({ source: 'resident-pet', type: 'dispatch.completed', occurredAt: new Date().toISOString(),
      payload: { ...source, scope: { namespace: 'channel', id }, reply: 'not saved' } });
    await waitFor(() => events.some(event => event.type === 'channel.delivery_failed'));
    assert.deepEqual(events.find(event => event.type === 'channel.delivery_failed')?.payload,
      { channelId: id, ...source, eventType: 'dispatch.completed', error: 'disk unavailable' });
    assert.equal(channel.service.readHistory(id).entries.length, 1);
    channel.service.recordInterrupt = () => { throw new Error('notice disk unavailable'); };
    studio.notify({ source: 'resident-pet', type: 'dispatch.waiting', occurredAt: new Date().toISOString(),
      payload: { ...source, scope: { namespace: 'channel', id }, pendingInterrupt } });
    await waitFor(() => events.filter(event => event.type === 'channel.delivery_failed').length === 2);
  } finally { await studio.shutdown(); }
});
