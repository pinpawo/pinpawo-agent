import assert from 'node:assert/strict';
import { readChannelTestInput, type ChannelTestInput } from '../../support/channelDispatchInput';
import test from 'node:test';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Annotation, Command, END, START, StateGraph, interrupt } from '@langchain/langgraph';
import { AIMessage, type BaseMessage } from '@langchain/core/messages';
import { buildReviewSpec, readPendingInterrupt } from '@pinpawo/pet-agent';
import { createChannelPlugin } from '@pinpawo-plugin/channel';
import { createStudio } from '@pinpawo/studio';
import { buildHostRuntimeConfig, createResidentPetHost, FileSaver, readPetInvocationContext } from 'pinpawo/host-runtime';
import { createTestModelProfiles } from '../../../services/host/src/testing/modelProfiles';
import { HostToolkitInventoryStore } from '../../../services/host/src/toolkits/toolkitInventory';
import type { AgentChannelSetup } from '../../../services/host/src/agent/agentChannel';
import type { InterruptResume } from '../../../services/host/src/agent/agentGraphService';

async function waitFor(done: () => boolean | Promise<boolean>) {
  for (let i = 0; i < 500; i++) { if (await done()) return; await new Promise(r => setTimeout(r, 5)); }
  throw new Error('Timed out');
}
async function fixture(root: string, pets = ['one'], reply?: (input: string) => string) {
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
      const input = /^`{3,}json\n/.test(raw) ? readChannelTestInput(raw) : undefined;
      const last = input?.body ?? raw;
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
      modelProfiles: createTestModelProfiles(), toolAuthorizationMode: 'require_authorization', autoAuthorizationSafetyLevel: 'strict',
      capabilities: [], toolkitInventory: new HostToolkitInventoryStore(), checkpointer, sessionStatePath: runtimeConfig.tuiSessionPath,
      capabilityArtifactStore: { writeArtifact: async () => { throw Error('unused'); }, readArtifact: async () => { throw Error('unused'); },
        listArtifacts: async () => [], deleteThreadArtifacts: async () => {}, getDownloadUri: async uri => uri },
      graphService: graphService as never,
    }));
  }
  const studio = await createStudio({ studioId: 'sessions', entryPetId: pets[0]!, plugins: [channel],
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
  return (await f.channel.service.readContext(f.channel.operator, channelId, { limit: 200 })).messages.filter(m => m.author.kind === 'pet');
}
const open = async (f: Fixture) => (await f.channel.service.createChannel(f.channel.operator, { title: 'Goal', pets: f.pets })).channel.channelId;
const ask = (f: Fixture, channelId: string, petId: string, body: string, replyTo?: string) =>
  f.channel.sendMessage(channelId, { body, ...(replyTo ? { replyTo } : {}), mentions: [{ participantId: `pet:${petId}` }] });
/** The dispatch.message event a Channel message was written from. */
const replyOf = (f: Fixture, externalRef?: string) =>
  f.events.find(e => e.type === 'dispatch.message' && e.payload.message.messageId === externalRef)?.payload;
const failures = (f: Fixture) => f.events.filter(e => e.type === 'channel.message_failed').map(e => e.payload);

test('Markdown targets a legal special Pet identity without dispatching its registered prefix', async () => {
  const root = await mkdtemp(join(tmpdir(), 'channel-special-identity-'));
  const f = await fixture(root, ['a', 'a)b'], () => 'Special identity delivery.');
  try {
    const id = await open(f);
    const result = await f.channel.sendMessage(id, { body: '[@Same name](participant:pet:a%29b) Inspect this.' });
    assert.deepEqual(result.deliveries.map(d => [d.participantId, d.state]), [['pet:a%29b', 'accepted']]);
    await waitFor(async () => (await outputs(f, id)).length === 1);
    assert.deepEqual(f.calls.map(call => call.petId), ['a)b']);
    assert.equal((await outputs(f, id))[0]!.author.id, 'a)b');
    assert.equal(await f.channel.service.getSession(id, 'a'), undefined);
  } finally { await f.close(); await rm(root, { recursive: true, force: true }); }
});

test('Channel pair sessions survive new messages, replies and restart; four Pets keep independent threads', async () => {
  const root = await mkdtemp(join(tmpdir(), 'channel-sessions-'));
  const pets = ['one', 'two', 'three', 'four'];
  let f = await fixture(root, pets);
  try {
    const a = await open(f);
    const b = await open(f);
    const first = await f.channel.sendMessage(` \t${a}\n `, { body: 'ask', mentions: pets.map(p => ({ participantId: `pet:${p}` })) });
    await waitFor(async () => (await outputs(f, a)).length === 4);
    const bindings = (await Promise.all(pets.map(p => f.channel.service.getSession(a, p)))).map(binding => binding!);
    assert.deepEqual(first.deliveries.map(d => [d.state, d.sessionId]), bindings.map(binding => ['accepted', binding.sessionId]));
    assert.equal(new Set(bindings.map(b => b.sessionId)).size, 4);
    assert.ok(f.maxActive() > 1, 'different Pets retain parallel execution');
    const question = (await outputs(f, a)).find(m => m.author.id === 'one')!;
    await ask(f, ` ${a} `, 'one', 'staging', question.messageId);
    await waitFor(async () => (await outputs(f, a)).length === 5);
    assert.equal((await outputs(f, a)).at(-1)!.body, 'Answer 2: staging');
    assert.deepEqual(f.calls.at(-1)!.input?.replyTo, {
      messageId: question.messageId, author: { participantId: 'pet:one', kind: 'pet' }, body: question.body,
    });
    assert.deepEqual(f.calls.at(-1)!.input?.author, { participantId: 'human:studio-operator', kind: 'human' });
    assert.deepEqual((await f.channel.sendMessage(a, { body: 'no recipient', replyTo: question.messageId })).deliveries, []);
    await assert.rejects(ask(f, b, 'one', 'wrong Channel', question.messageId), /reference/);
    await assert.rejects(ask(f, a, 'missing', 'unknown target', question.messageId), /Unknown/);
    await ask(f, b, 'one', 'new Channel');
    await waitFor(async () => (await outputs(f, b)).length === 1);
    assert.equal(f.calls.length, 6, 'an unaddressed reply dispatches nobody');
    assert.notEqual((await f.channel.service.getSession(b, 'one'))!.sessionId, bindings[0]!.sessionId);
    await f.close();
    f = await fixture(root, pets);
    assert.deepEqual(await Promise.all(pets.map(p => f.channel.service.getSession(a, p))), bindings);
    await Promise.all([ask(f, a, 'one', 'next task'), ask(f, a, 'one', 'another task')]);
    await waitFor(async () => (await outputs(f, a)).length === 7);
    assert.deepEqual(f.calls.map(c => [c.thread, c.count]), [[bindings[0]!.sessionId, 3], [bindings[0]!.sessionId, 4]]);
    assert.equal(f.maxActive(), 1, 'same Pet remains serial');
    await f.close();
    const registry = buildHostRuntimeConfig(join(root, 'one')).tuiSessionPath;
    const saved = JSON.parse(await readFile(registry, 'utf8'));
    delete saved.sessions[bindings[0]!.sessionId];
    await writeFile(registry, JSON.stringify(saved));
    f = await fixture(root, pets);
    const { deliveries: [lost] } = await ask(f, a, 'one', 'must not recreate');
    assert.equal(lost!.state, 'failed');
    assert.match(lost!.error!, /no longer exists/);
    assert.equal((await f.channel.service.getSession(a, 'one'))!.sessionId, bindings[0]!.sessionId);
  } finally { await f.close(); await rm(root, { recursive: true, force: true }); }
});

test('waiting target is skipped; background execution does not pollute active TUI and original review resumes there', async () => {
  const root = await mkdtemp(join(tmpdir(), 'channel-waiting-'));
  const f = await fixture(root);
  try {
    const host = f.hosts[0]!;
    const initial = await host.interaction.snapshot();
    const observed: unknown[] = [];
    host.interaction.subscribe(m => observed.push(m));
    const a = await open(f);
    const b = await open(f);
    const waiting: string[] = [];
    const stop = host.resident.dispatch.onDispatchLifecycle(e => { if (e.state === 'waiting') waiting.push(e.sessionId!); });
    const { deliveries: [approval] } = await ask(f, a, 'one', 'approval');
    await waitFor(() => waiting.length === 1);
    const binding = (await f.channel.service.getSession(a, 'one'))!;
    assert.deepEqual(waiting, [binding.sessionId]);
    assert.equal((await outputs(f, a)).length, 0, 'a pending review is not a Channel message');
    assert.ok(!JSON.stringify(await f.channel.service.readContext(f.channel.operator, a)).includes('Authorize?'));
    await ask(f, a, 'one', 'after approval');
    await ask(f, b, 'one', 'other session');
    await waitFor(async () => (await outputs(f, b)).length === 1);
    assert.equal(f.calls.length, 1);
    assert.equal(observed.length, 0, 'background run does not enter active-session stream');
    const snapshot = await host.interaction.snapshot();
    assert.equal(snapshot.type, 'session.snapshot.result');
    assert.equal(initial.type, 'session.snapshot.result');
    if (snapshot.type !== 'session.snapshot.result' || initial.type !== 'session.snapshot.result') throw Error('snapshot');
    assert.deepEqual(snapshot.snapshot, initial.snapshot);
    await host.interaction.request({ type: 'session.resume', requestId: 'select-a', sessionId: binding.sessionId });
    const selected = await host.interaction.snapshot();
    assert.ok(JSON.stringify(selected).includes(binding.sessionId));
    // Read the actual projected interrupt, then send the existing TUI command.
    if (selected.type !== 'session.snapshot.result') throw Error('snapshot');
    const pending = selected.snapshot.session.pendingInterrupt;
    assert.ok(pending);
    assert.equal(pending.payload.kind, 'human_review');
    await ask(f, b, 'one', 'while active session awaits approval');
    await waitFor(async () => (await outputs(f, b)).length === 2);
    const stillWaiting = await host.interaction.snapshot();
    if (stillWaiting.type !== 'session.snapshot.result') throw Error('snapshot');
    assert.equal(stillWaiting.snapshot.session.pendingInterrupt?.interruptId, pending.interruptId);
    await host.interaction.request({ type: 'interrupt.resume', requestId: 'approve-a', interruptId: pending.interruptId,
      value: { decisions: [{ interactionId: 'approval', selectedOptionId: 'approve' }] } });
    // Approving the review continues the original dispatch: its reply lands in
    // the Channel as the Pet's message, before the queued follow-up runs.
    await waitFor(async () => (await outputs(f, a)).length === 2);
    assert.deepEqual((await outputs(f, a)).map(m => m.body), ['Answer 1: approval', 'Answer 2: after approval']);
    assert.deepEqual([replyOf(f, (await outputs(f, a))[0]!.externalRef)?.invocationId, replyOf(f, (await outputs(f, a))[0]!.externalRef)?.sessionId],
      [approval!.invocationId, binding.sessionId]);
    assert.ok(f.calls.some(call => call.text === 'approval' && call.thread === binding.sessionId), 'continuation keeps dispatch attribution');
    stop();
  } finally { await f.close(); await rm(root, { recursive: true, force: true }); }
});

test('a review answered after Host restart still lands the dispatch result in its Channel', async () => {
  const root = await mkdtemp(join(tmpdir(), 'channel-restart-approval-'));
  let f = await fixture(root);
  try {
    const a = await open(f);
    const waiting: string[] = [];
    f.hosts[0]!.resident.dispatch.onDispatchLifecycle(e => { if (e.state === 'waiting') waiting.push(e.sessionId!); });
    const { deliveries: [approval] } = await ask(f, a, 'one', 'approval');
    await waitFor(() => waiting.length === 1);
    assert.equal(waiting[0], (await f.channel.service.getSession(a, 'one'))!.sessionId);
    await f.close();
    f = await fixture(root);
    const host = f.hosts[0]!;
    await host.interaction.request({ type: 'session.resume', requestId: 'select', sessionId: waiting[0]! });
    const selected = await host.interaction.snapshot();
    if (selected.type !== 'session.snapshot.result') throw Error('snapshot');
    const pending = selected.snapshot.session.pendingInterrupt;
    assert.ok(pending);
    await host.interaction.request({ type: 'interrupt.resume', requestId: 'approve', interruptId: pending.interruptId,
      value: { decisions: [{ interactionId: 'approval', selectedOptionId: 'approve' }] } });
    await waitFor(async () => (await outputs(f, a)).length === 1);
    assert.equal((await outputs(f, a))[0]?.body, 'Answer 1: approval');
    assert.equal(replyOf(f, (await outputs(f, a))[0]!.externalRef)?.invocationId, approval!.invocationId);
    assert.equal(f.calls[0]?.thread, waiting[0], 'restored scope reaches the Channel session');
  } finally { await f.close(); await rm(root, { recursive: true, force: true }); }
});

test('concurrent first use reserves one session; queued targets survive a TUI switch and snapshots exclude background runs', async () => {
  const root = await mkdtemp(join(tmpdir(), 'channel-target-'));
  const f = await fixture(root);
  let release!: () => void;
  f.barrier.wait = new Promise<void>(resolve => { release = resolve; });
  try {
    const a = await open(f);
    const b = await open(f);
    const sent = await Promise.all([ask(f, a, 'one', 'first'), ask(f, a, 'one', 'second')]);
    await waitFor(() => f.active() === 1);
    const binding = (await f.channel.service.getSession(a, 'one'))!;
    assert.deepEqual(sent.map(result => result.deliveries[0]!.sessionId), [binding.sessionId, binding.sessionId]);
    const snapshot = await f.hosts[0]!.interaction.snapshot();
    if (snapshot.type !== 'session.snapshot.result') throw Error('snapshot');
    assert.equal(snapshot.snapshot.session.activeRun, null);
    await ask(f, b, 'one', 'third');
    const switched = f.hosts[0]!.interaction.request({ type: 'session.new', requestId: 'new-tui' });
    f.barrier.wait = undefined; release();
    await switched;
    await waitFor(async () => (await outputs(f, a)).length === 2 && (await outputs(f, b)).length === 1);
    assert.deepEqual(f.calls.map(c => c.thread), [binding.sessionId, binding.sessionId, (await f.channel.service.getSession(b, 'one'))!.sessionId]);
    assert.equal(f.maxActive(), 1);
    await assert.rejects(f.hosts[0]!.resident.dispatch.dispatch({ request: 'wrong pet', session: { id: 'other:12345678', create: true } }), /identity/);
  } finally { release(); await f.close(); await rm(root, { recursive: true, force: true }); }
});

test('failed first admission keeps the reserved identity for retry; a replayed public reply is written once', async () => {
  const root = await mkdtemp(join(tmpdir(), 'channel-reservation-'));
  const file = join(root, 'channels.sqlite');
  let fail = true;
  const targets: string[] = [];
  let channel = createChannelPlugin({ httpRoute: false });
  const create = () => createStudio({ studioId: 'retry', entryPetId: 'one', plugins: [channel], storage: { kind: 'sqlite', path: file }, pets: [{
    registration: { petId: 'one', name: 'One' }, dispatch: {
      getQueueSnapshot: () => ({ state: 'open', activeOperation: null, queuedConversations: 0, queuedDispatches: 0 }),
      onQueueChange: () => () => {}, onDispatchLifecycle: () => () => {},
      dispatch: async (input) => { targets.push(input.session!.id); if (fail) throw Error('registration unavailable'); },
    },
  }] });
  let studio = await create();
  try {
    const id = (await channel.service.createChannel(channel.operator, { title: 'Goal', pets: ['one'] })).channel.channelId;
    const start = { body: 'start', mentions: [{ participantId: 'pet:one' }] };
    const { deliveries: [failed] } = await channel.sendMessage(id, start);
    assert.equal(failed!.state, 'failed');
    assert.match(failed!.error!, /unavailable/);
    const reserved = (await channel.service.getSession(id, 'one'))!;
    assert.equal(reserved.registered, false);
    await studio.shutdown();
    channel = createChannelPlugin({ httpRoute: false });
    studio = await create(); fail = false;
    const { deliveries: [retried] } = await channel.sendMessage(id, { ...start, body: 'retry' });
    assert.deepEqual([retried!.state, retried!.sessionId], ['accepted', reserved.sessionId]);
    assert.deepEqual(targets, [reserved.sessionId, reserved.sessionId]);
    assert.equal((await channel.service.getSession(id, 'one'))!.registered, true);
    const events: Array<{ type: string; payload?: any }> = [];
    studio.subscribe(event => { events.push(event); });
    const reply = (sessionId: string) => studio.notify({ source: 'resident-pet', type: 'dispatch.message', occurredAt: new Date().toISOString(),
      payload: { petId: 'one', invocationId: retried!.invocationId, sessionId, scope: { namespace: 'channel', id },
        message: { type: 'message.completed', messageId: 'reply-1', role: 'assistant', text: 'Which destination?' } } });
    reply(reserved.sessionId); reply(reserved.sessionId); reply('one:forged');
    // Events reach the Channel in order: once the forged one has failed, the replay was handled.
    await waitFor(() => events.some(event => event.type === 'channel.message_failed'));
    const messages = (await channel.service.readContext(channel.operator, id)).messages.filter(message => message.author.kind === 'pet');
    assert.deepEqual(messages.map(message => [message.body, message.externalRef]), [['Which destination?', 'reply-1']]);
  } finally { await studio.shutdown(); await rm(root, { recursive: true, force: true }); }
});

test('a bound session alone does not publish; scope mismatch and a departed Pet report failure; native review is not a message', async () => {
  const root = await mkdtemp(join(tmpdir(), 'channel-destination-'));
  const f = await fixture(root);
  try {
    assert.deepEqual(f.channel.toolkits.flatMap(t => t.tools).map(t => t.tool.name), ['channel_read_context']);
    const a = await open(f);
    const b = await open(f);
    const { deliveries: [first] } = await ask(f, a, 'one', 'ask');
    const sessionId = first!.sessionId!;
    await waitFor(async () => (await outputs(f, a)).length === 1);
    const receipt = await f.studio.dispatch({ petId: 'one', request: 'not public', session: { id: sessionId }, metadata: { channelId: a } });
    await waitFor(() => f.events.some(e => e.type === 'dispatch.completed' && e.payload.invocationId === receipt.invocationId));
    assert.equal((await outputs(f, a)).length, 1);
    await f.studio.dispatch({ petId: 'one', request: 'wrong destination', session: { id: sessionId }, scope: { namespace: 'channel', id: b } });
    await waitFor(() => failures(f).length === 1);
    assert.deepEqual([failures(f)[0].channelId, failures(f)[0].sessionId], [b, sessionId]);
    assert.match(failures(f)[0].error, /session does not match/);
    assert.equal((await outputs(f, b)).length, 0);
    await f.channel.service.removeMember(f.channel.operator, a, { kind: 'pet', id: 'one' });
    await f.studio.dispatch({ petId: 'one', request: 'after leaving', session: { id: sessionId }, scope: { namespace: 'channel', id: a } });
    await waitFor(() => failures(f).length === 2);
    assert.deepEqual([failures(f)[1].channelId, failures(f)[1].petId], [a, 'one']);
    assert.match(failures(f)[1].error, /not a member/);
    assert.equal((await outputs(f, a)).length, 1);
    const waiting: string[] = [];
    f.hosts[0]!.resident.dispatch.onDispatchLifecycle(e => { if (e.state === 'waiting') waiting.push(e.sessionId!); });
    await ask(f, b, 'one', 'approval');
    await waitFor(() => waiting.length === 1);
    assert.equal((await outputs(f, b)).length, 0);
    assert.ok(!/interruptId|Authorize\?/.test(JSON.stringify(await f.channel.service.readContext(f.channel.operator, b))));
  } finally { await f.close(); await rm(root, { recursive: true, force: true }); }
});
