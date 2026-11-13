import assert from 'node:assert/strict';
import { readChannelTestTask, type ChannelTestInput } from '../../support/channelDispatchInput';
import test from 'node:test';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Annotation, Command, END, START, StateGraph, interrupt } from '@langchain/langgraph';
import { AIMessage, type BaseMessage } from '@langchain/core/messages';
import { buildReviewSpec, readPendingInterrupt } from '@pinpawo/pet-agent';
import { createChannelPlugin } from '@pinpawo-plugin/channel';

import { buildHostRuntimeConfig, createResidentPetHost, FileSaver, readPetInvocationContext } from 'pinpawo/host-runtime';
import { createTestModelProfiles } from '../../../services/host/src/testing/modelProfiles';
import { HostToolkitInventoryStore } from '../../../services/host/src/toolkits/toolkitInventory';
import type { AgentChannelSetup } from '../../../services/host/src/agent/agentChannel';
import type { InterruptResume } from '../../../services/host/src/agent/agentGraphService';
import { createChannelWithPets, createStudioWithPets } from '../../../tests/support/livePets';
import { createInvocationContextBridge } from './invocationContextBridge';

/** The local Host token's Studio client, as a Channel member. */
const me = { kind: 'human' as const, id: 'local' };

async function waitFor(done: () => boolean | Promise<boolean>) {
  for (let i = 0; i < 500; i++) { if (await done()) return; await new Promise(r => setTimeout(r, 5)); }
  throw new Error('Timed out');
}
async function fixture(root: string, pets = ['one'], reply?: (input: string) => string) {
  const contextBridge = createInvocationContextBridge();
  const channel = createChannelPlugin({ httpRoute: false });
  const hosts: Awaited<ReturnType<typeof createResidentPetHost>>[] = [];
  const calls: Array<{ petId: string; thread: string; text: string; count: number; input?: ChannelTestInput }> = [];
  let active = 0, maxActive = 0;
  const barrier: { wait?: Promise<void> } = {};
  for (const petId of pets) {
    const runtimeConfig = buildHostRuntimeConfig(join(root, petId));
    const checkpointer = new FileSaver(runtimeConfig.checkpointPath);
    const State = Annotation.Root({ messages: Annotation<BaseMessage[]>({ reducer: (a, b) => [...a, ...b], default: () => [] }) });
    const graph = new StateGraph(State).addNode('reply', async (state) => {
      const raw = state.messages.at(-1)!.text;
      const input = undefined;
      const last = /^`{3,}json\n/.test(raw) ? readChannelTestTask(raw).body : raw;
      if (last === 'approval') interrupt({ kind: 'review', review: buildReviewSpec({ id: 'approval',
        view: { kind: 'plain', body: 'Authorize?' }, options: [{ id: 'approve', label: 'Approve', decision: { type: 'approve' }, effects: [{ type: 'graph.authorize_tool_action', scope: 'thread' }] }],
      }) });
      active++; maxActive = Math.max(maxActive, active);
      try {
        await barrier.wait;
        await new Promise(r => setTimeout(r, 20));
        const invocation = readPetInvocationContext();
        const count = state.messages.filter(m => m._getType() === 'human').length;
        calls.push({ petId, thread: invocation?.sessionId ?? 'tui', text: last, count, input });
        return { messages: [new AIMessage(reply ? reply(last) : last === 'ask' ? 'Which destination?' : `Answer ${count}: ${last}`)] };
      } finally { active--; }
    }).addEdge(START, 'reply').addEdge('reply', END).compile({ checkpointer });
    const config = (setup: AgentChannelSetup) => ({ configurable: { thread_id: setup.input.threadId } });
    const graphService = {
      async readThreadState(setup: AgentChannelSetup) {
        const snapshot = await graph.getState(config(setup));
        return { messages: snapshot.values.messages ?? [], pendingInterrupt: readPendingInterrupt(snapshot),
          acceptsResume: snapshot.next.length > 0 || snapshot.tasks.length > 0, currentPlan: null };
      },
      async streamEvents(setup: AgentChannelSetup, resume?: InterruptResume) {
        return graph.streamEvents(resume ? new Command({ resume: { [resume.interruptId]: resume.value } }) : { messages: setup.input.messages },
          { ...config(setup), version: 'v3' });
      },
    };
    hosts.push(await createResidentPetHost({ petId, petName: petId, runtimeConfig,
      resolveInvocationContext: contextBridge.resolveInvocationContext,
      modelProfiles: createTestModelProfiles(), toolAuthorizationMode: 'require_authorization', autoAuthorizationSafetyLevel: 'strict',
      capabilities: [], toolkitInventory: new HostToolkitInventoryStore(), checkpointer, sessionStatePath: runtimeConfig.tuiSessionPath,
      graphService: graphService as never,
    }));
  }
  const studio = await createStudioWithPets({ studioId: 'sessions', plugins: [channel],
    onPreparedContextResolver: contextBridge.onPreparedContextResolver,
    storage: { kind: 'sqlite', path: join(root, 'channels.sqlite') },
    pets: hosts.map((host, i) => ({ registration: { petId: pets[i]!, name: pets[i]! }, dispatch: host.resident.dispatch })),
  });
  const events: Array<{ type: string; payload?: any }> = [];
  studio.subscribe(event => { events.push(event); });
  return { channel, hosts, studio, calls, events, pets, maxActive: () => maxActive, active: () => active, barrier,
    close: async () => { await Promise.all(hosts.map(h => h.close())); await studio.shutdown(); } };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
async function outputs(f: Fixture, channelId: string) {
  return (await f.channel.service.readContext(me, channelId, { limit: 200 })).messages.filter(m => m.author.kind === 'pet');
}
const open = async (f: Fixture) => (await createChannelWithPets(f.studio, f.channel.service, me, { title: 'Goal', pets: f.pets })).channel.channelId;
const failures = (f: Fixture) => f.events.filter(e => e.type === 'channel.message_failed').map(e => e.payload);

test('a bound session alone does not publish; invalid scopes and late replies fail; native review is not a message', async () => {
  const root = await mkdtemp(join(tmpdir(), 'channel-destination-'));
  const f = await fixture(root, ['one', 'two']);
  try {
    assert.deepEqual(f.channel.toolkits.flatMap(t => t.tools).map(t => t.tool.name), ['channel_read_context']);
    const a = await open(f);
    const b = (await f.channel.service.createChannel(me, { title: 'Other', pets: [] })).channel.channelId;
    const first = await f.channel.run(a, 'one', 'ask', { kind: 'trigger', id: 'test' });
    const sessionId = first.sessionId;
    await waitFor(async () => (await outputs(f, a)).length === 1);
    const receipt = await f.studio.dispatch({ petId: 'one', request: 'not public', session: { id: sessionId }, metadata: { channelId: a } });
    await waitFor(() => f.events.some(e => e.type === 'dispatch.completed' && e.payload.invocationId === receipt.invocationId));
    assert.equal((await outputs(f, a)).length, 1);
    const acceptedCalls = f.calls.length;
    await assert.rejects(f.studio.dispatch({ petId: 'one', request: 'wrong destination', session: { id: sessionId }, scope: { namespace: 'channel', id: b } }), /binding/);
    assert.equal(f.calls.length, acceptedCalls, 'invalid scope is rejected before a run is queued');
    // Late or forged Host events must still fail safely even though new runs
    // are rejected at admission.
    const lateReply = (channelId: string, id: string) => f.studio.notify({ source: 'resident-pet', type: 'dispatch.message', occurredAt: new Date().toISOString(),
      payload: { petId: 'one', invocationId: id, sessionId, scope: { namespace: 'channel', id: channelId },
        message: { type: 'message.completed', messageId: id, role: 'assistant', text: 'Must not be published.' } } });
    lateReply(b, 'wrong-destination');
    await waitFor(() => failures(f).length === 1);
    assert.deepEqual([failures(f)[0].channelId, failures(f)[0].sessionId], [b, sessionId]);
    assert.match(failures(f)[0].error, /session does not match/);
    assert.equal((await outputs(f, b)).length, 0);
    await f.channel.service.removeMember(me, a, { kind: 'pet', id: 'one' }, { confirmStop: true });
    await assert.rejects(f.studio.dispatch({ petId: 'one', request: 'after leaving', session: { id: sessionId }, scope: { namespace: 'channel', id: a } }), /unknown petId/);
    assert.equal(f.calls.length, acceptedCalls, 'former members are rejected before a run is queued');
    lateReply(a, 'former-member');
    await waitFor(() => failures(f).length === 2);
    assert.deepEqual([failures(f)[1].channelId, failures(f)[1].petId], [a, 'one']);
    assert.match(failures(f)[1].error, /not a member/);
    assert.equal((await outputs(f, a)).length, 1);
    const waiting: string[] = [];
    f.hosts[1]!.resident.dispatch.onDispatchLifecycle(e => { if (e.state === 'waiting') waiting.push(e.sessionId!); });
    await f.channel.run(a, 'two', 'approval', { kind: 'trigger', id: 'test' });
    await waitFor(() => waiting.length === 1);
    assert.equal((await outputs(f, a)).length, 1);
    assert.ok(!/interruptId|Authorize\?/.test(JSON.stringify(await f.channel.service.readContext(me, a))));
  } finally { await f.close(); await rm(root, { recursive: true, force: true }); }
});

test('explicit runs reuse a Pet session across restart and concurrent submissions', async () => {
  const root = await mkdtemp(join(tmpdir(), 'channel-run-session-'));
  let f = await fixture(root);
  try {
    const id = await open(f);
    const origin = { kind: 'trigger' as const, id: 'test' };
    const receipts = await Promise.all([
      f.channel.run(id, 'one', 'first', origin),
      f.channel.run(id, 'one', 'second', origin),
    ]);
    assert.equal(receipts[0]!.sessionId, receipts[1]!.sessionId);
    await waitFor(async () => (await outputs(f, id)).length === 2);
    const binding = await f.channel.service.getSession(id, 'one');
    assert.equal(binding?.registered, true);
    assert.deepEqual(f.calls.map(call => call.thread), [binding!.sessionId, binding!.sessionId]);
    await f.close();
    f = await fixture(root);
    assert.deepEqual(await f.channel.service.getSession(id, 'one'), binding);
    const afterRestart = await f.channel.run(id, 'one', 'third', origin);
    assert.equal(afterRestart.sessionId, binding!.sessionId);
    await waitFor(async () => (await outputs(f, id)).length === 3);
    assert.deepEqual(f.calls.map(call => [call.thread, call.count]), [[binding!.sessionId, 3]]);
  } finally { await f.close(); await rm(root, { recursive: true, force: true }); }
});

test('a failed explicit run retains its reserved session for a retry', async () => {
  const root = await mkdtemp(join(tmpdir(), 'channel-run-retry-'));
  let fail = true;
  const targets: string[] = [];
  const channel = createChannelPlugin({ httpRoute: false });
  const studio = await createStudioWithPets({ studioId: 'retry', plugins: [channel], pets: [{
    registration: { petId: 'one', name: 'One' }, dispatch: {
      getQueueSnapshot: () => ({ state: 'open', activeOperation: null, queuedConversations: 0, queuedDispatches: 0 }),
      onQueueChange: () => () => {}, onDispatchLifecycle: () => () => {},
      dispatch: async input => { targets.push(input.session!.id); if (fail) throw Error('registration unavailable'); },
    },
  }] });
  try {
    const id = (await createChannelWithPets(studio, channel.service, me, { title: 'Goal', pets: ['one'] })).channel.channelId;
    const origin = { kind: 'trigger' as const, id: 'test' };
    await assert.rejects(channel.run(id, 'one', 'first', origin), /registration unavailable/);
    const binding = (await channel.service.getSession(id, 'one'))!;
    assert.equal(binding.registered, false);
    fail = false;
    const retry = await channel.run(id, 'one', 'retry', origin);
    assert.equal(retry.sessionId, binding.sessionId);
    assert.deepEqual(targets, [binding.sessionId, binding.sessionId]);
    assert.equal((await channel.service.getSession(id, 'one'))!.registered, true);
  } finally { await studio.shutdown(); await rm(root, { recursive: true, force: true }); }
});
