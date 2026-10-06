import assert from 'node:assert/strict';
import { readChannelTestInput, type ChannelTestInput } from '../../support/channelDispatchInput';
import test from 'node:test';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Annotation, Command, END, START, StateGraph, interrupt } from '@langchain/langgraph';
import { AIMessage, type BaseMessage } from '@langchain/core/messages';
import { buildReviewSpec, readPendingInterrupt, prepareRuntimeExecution, readRuntimeRecoveryDescriptor } from '@pinpawo/pet-agent';
import { createChannelPlugin, type ChannelMessage } from '@pinpawo-plugin/channel';
import { createStudio } from '@pinpawo/studio';
import { buildHostRuntimeConfig, createResidentPetHost, FileSaver, readPetInvocationContext } from 'pinpawo/host-runtime';
import { createTestModelProfiles } from '../../../services/host/src/testing/modelProfiles';
import { HostToolkitInventoryStore } from '../../../services/host/src/toolkits/toolkitInventory';
import type { AgentChannelSetup } from '../../../services/host/src/agent/agentChannel';
import type { InterruptResume } from '../../../services/host/src/agent/agentGraphService';

async function waitFor(done: () => boolean) {
  for (let i = 0; i < 500; i++) { if (done()) return; await new Promise(r => setTimeout(r, 5)); }
  throw new Error('Timed out');
}
const human = { kind: 'human', id: 'owner' } as const;
const goal = { title: 'Goal', goal: 'Long term', scope: 'This round' };
async function fixture(root: string, pets = ['one'], reply?: (input: string) => string) {
  const channel = createChannelPlugin({ databasePath: join(root, 'channels.sqlite'), httpRoute: false });
  const hosts: Awaited<ReturnType<typeof createResidentPetHost>>[] = [];
  const calls: Array<{ petId: string; thread: string; text: string; count: number; input?: ChannelTestInput }> = [];
  let active = 0, maxActive = 0;
  const barrier: { wait?: Promise<void> } = {};
  for (const petId of pets) {
    const runtimeConfig = buildHostRuntimeConfig(join(root, petId));
    const checkpointer = new FileSaver(runtimeConfig.checkpointPath);
    const State = Annotation.Root({
      runId: Annotation<string>({ reducer: (_a, b) => b, default: () => '' }),
      taskId: Annotation<string>({ reducer: (_a, b) => b, default: () => '' }),
      messages: Annotation<BaseMessage[]>({ reducer: (a, b) => [...a, ...b], default: () => [] }) });
    const graph = new StateGraph(State).addNode('reply', async (state) => {
      const raw = state.messages.at(-1)!.text;
      const input = /^`{3,}json\n/.test(raw) ? readChannelTestInput(raw) : undefined;
      const last = input?.body ?? raw;
      if (last === 'approval' || last === 'approval-failure' || last === 'approval-cancel') {
        const resolution = interrupt({ kind: 'review', review: buildReviewSpec({ id: 'approval',
        view: { kind: 'plain', body: 'Authorize?' }, options: [{ id: 'approve', label: 'Approve', decision: { type: 'approve' }, effects: [{ type: 'graph.authorize_tool_action', scope: 'thread' }] }, { id: 'reject', label: 'Reject', decision: { type: 'reject' } }],
      }) });
        if (resolution?.action === 'interrupt_run' || resolution?.decisions?.[0]?.selectedOptionId === 'reject') return { messages: [new AIMessage('Action withdrawn.')] };
        const read = channel.toolkits[0]!.tools.find(t => t.tool.name === 'channel_read_context')!;
        const context = JSON.parse(await read.tool.invoke({}));
        assert.equal(context.channel.channelId, readPetInvocationContext()?.scope?.id);
      }
      if (last === 'approval-failure') throw new Error('deterministic resume failure');
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
      async readExecutionDescriptor(setup: AgentChannelSetup) {
        return readRuntimeRecoveryDescriptor(await graph.getState(config(setup)), setup.input.threadId!);
      },
      async streamEvents(setup: AgentChannelSetup, resume?: InterruptResume, onIdentity?: (identity: import('@pinpawo/pet-agent').RuntimeExecutionIdentity) => void) {
        const prepared = resume ? undefined : prepareRuntimeExecution(setup.input.messages, setup.input.threadId!);
        const identity = prepared?.identity ?? (await this.readExecutionDescriptor(setup)).identity;
        if (identity) onIdentity?.(identity);
        return graph.streamEvents(resume ? new Command({ resume: { [resume.interruptId]: resume.value } }) : prepared!.input,
          { ...config(setup), version: 'v3' });
      },
    };
    hosts.push(await createResidentPetHost({ petId, petName: petId, runtimeConfig,
      modelProfiles: createTestModelProfiles(), globalReviewPolicyMode: 'require_authorization', autoAuthorizationSafetyLevel: 'strict',
      capabilities: [], toolkitInventory: new HostToolkitInventoryStore(), checkpointer, sessionStatePath: runtimeConfig.tuiSessionPath,
      capabilityArtifactStore: { writeArtifact: async () => { throw Error('unused'); }, readArtifact: async () => { throw Error('unused'); },
        listArtifacts: async () => [], deleteThreadArtifacts: async () => {}, getDownloadUri: async uri => uri },
      graphService: graphService as never,
    }));
  }
  const studio = await createStudio({ studioId: 'sessions', entryPetId: pets[0]!, plugins: [channel],
    pets: hosts.map((host, i) => ({ registration: { petId: pets[i]!, name: pets[i]! }, dispatch: host.resident.dispatch })),
  });
  return { channel, hosts, studio, calls, maxActive: () => maxActive, active: () => active, barrier,
    close: async () => { await Promise.all(hosts.map(h => h.close())); await studio.shutdown(); } };
}
function outputs(f: Awaited<ReturnType<typeof fixture>>, channelId: string) {
  return f.channel.service.readHistory(channelId).entries.filter((m): m is ChannelMessage => m.kind === 'message' && !!m.source);
}

test('Markdown targets a legal special Pet identity without dispatching its registered prefix', async () => {
  const root = await mkdtemp(join(tmpdir(), 'channel-special-identity-'));
  const f = await fixture(root, ['a', 'a)b'], () => 'Special identity delivery.');
  try {
    const id = f.channel.service.createChannel(goal, human).channelId;
    const result = await f.channel.sendMessage(id, { body: '[@Same name](participant:pet:a%29b) Inspect this.' });
    assert.equal(result.deliveries[0]?.participantId, 'pet:a%29b');
    await waitFor(() => outputs(f, id).length === 1);
    assert.deepEqual(f.calls.map(call => call.petId), ['a)b']);
    assert.equal(outputs(f, id)[0]!.author.id, 'a)b');
    assert.equal(f.channel.service.getBinding(id, 'a'), null);
  } finally { await f.close(); await rm(root, { recursive: true, force: true }); }
});

test('Channel pair sessions survive new tasks, replies and restart; four Pets keep independent threads', async () => {
  const root = await mkdtemp(join(tmpdir(), 'channel-sessions-'));
  let f = await fixture(root, ['one', 'two', 'three', 'four']);
  try {
    const a = f.channel.service.createChannel(goal, human).channelId;
    const b = f.channel.service.createChannel(goal, human).channelId;
    await Promise.all(['one', 'two', 'three', 'four'].map(petId => f.channel.execute(petId === 'one' ? ` \t${a}\n ` : a, { petId, body: 'ask' })));
    await waitFor(() => outputs(f, a).length === 4);
    const bindings = ['one', 'two', 'three', 'four'].map(p => f.channel.service.getBinding(a, p)!);
    assert.equal(new Set(bindings.map(b => b.sessionId)).size, 4);
    assert.ok(f.maxActive() > 1, 'different Pets retain parallel execution');
    const question = outputs(f, a).find(m => m.author.id === 'one')!;
    await f.channel.execute(` ${a} `, { replyTo: question.messageId, body: 'staging' });
    await waitFor(() => outputs(f, a).length === 5);
    assert.equal(outputs(f, a).at(-1)!.body, 'Answer 2: staging');
    assert.deepEqual(f.calls.at(-1)!.input?.replyTo, {
      messageId: question.messageId, author: { participantId: 'pet:one', kind: 'pet' }, body: question.body,
    });
    assert.deepEqual(f.calls.at(-1)!.input?.author, { participantId: 'human:studio-operator', kind: 'human' });
    await assert.rejects(f.channel.execute(b, { replyTo: question.messageId, body: 'wrong Channel' }), /reference/);
    await assert.rejects(f.channel.execute(a, { petId: 'missing', replyTo: question.messageId, body: 'unknown target' }), /Unknown/);
    await f.channel.execute(b, { petId: 'one', body: 'new Channel' });
    await waitFor(() => outputs(f, b).length === 1);
    assert.notEqual(f.channel.service.getBinding(b, 'one')!.sessionId, bindings[0]!.sessionId);
    await f.close();
    f = await fixture(root, ['one', 'two', 'three', 'four']);
    assert.deepEqual(['one', 'two', 'three', 'four'].map(p => f.channel.service.getBinding(a, p)), bindings);
    await Promise.all([f.channel.execute(a, { petId: 'one', body: 'next task' }), f.channel.execute(a, { petId: 'one', body: 'another task' })]);
    await waitFor(() => outputs(f, a).length === 7);
    assert.deepEqual(f.calls.map(c => [c.thread, c.count]), [[bindings[0]!.sessionId, 3], [bindings[0]!.sessionId, 4]]);
    assert.equal(f.maxActive(), 1, 'same Pet remains serial');
    await f.close();
    const registry = buildHostRuntimeConfig(join(root, 'one')).tuiSessionPath;
    const saved = JSON.parse(await readFile(registry, 'utf8'));
    delete saved.sessions[bindings[0]!.sessionId];
    await writeFile(registry, JSON.stringify(saved));
    f = await fixture(root, ['one', 'two', 'three', 'four']);
    await assert.rejects(f.channel.execute(a, { petId: 'one', body: 'must not recreate' }), /no longer exists/);
    assert.equal(f.channel.service.getBinding(a, 'one')!.sessionId, bindings[0]!.sessionId);
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
    const a = f.channel.service.createChannel(goal, human).channelId;
    const b = f.channel.service.createChannel(goal, human).channelId;
    await f.channel.execute(a, { petId: 'one', body: 'approval' });
    const waiting: string[] = [];
    const stop = host.resident.dispatch.onDispatchLifecycle(e => { if (e.state === 'waiting') waiting.push(e.sessionId!); });
    await waitFor(() => waiting.length === 1);
    const binding = f.channel.service.getBinding(a, 'one')!;
    await waitFor(() => f.channel.service.readInterruptNotifications(a).notifications.length === 1);
    const notice = f.channel.service.readInterruptNotifications(a).notifications[0]!;
    assert.equal(notice.source.sessionId, binding.sessionId);
    assert.equal(notice.pendingInterrupt.payload.kind, 'human_review');
    assert.ok(!JSON.stringify(notice).includes('graph.authorize_tool_action'));
    const read = f.channel.toolkits[0]!.tools.find(entry => entry.tool.name === 'channel_read_context');
    assert.ok(read);
    assert.ok(!JSON.stringify(f.channel.service.readContext(a)).includes('Authorize?'));
    await f.channel.execute(a, { petId: 'one', body: 'after approval' });
    await f.channel.execute(b, { petId: 'one', body: 'other session' });
    await waitFor(() => outputs(f, b).length === 1);
    assert.equal(f.calls.length, 1);
    assert.equal(observed.length, 0, 'background run does not enter active-session stream');
    const snapshot = await host.interaction.snapshot();
    assert.equal(snapshot.type, 'session.snapshot.result');
    assert.equal(initial.type, 'session.snapshot.result');
    if (snapshot.type !== 'session.snapshot.result' || initial.type !== 'session.snapshot.result') throw Error('snapshot');
    assert.deepEqual(snapshot.snapshot, initial.snapshot);
    await host.interaction.request({ type: 'session.resume', requestId: 'select-a', sessionId: binding.sessionId });
    const selected = await host.interaction.snapshot();
    const text = JSON.stringify(selected);
    assert.ok(text.includes(binding.sessionId));
    // Read the actual projected interrupt, then send the existing TUI command.
    if (selected.type !== 'session.snapshot.result') throw Error('snapshot');
    const pending = selected.snapshot.session.pendingInterrupt;
    assert.ok(pending);
    await f.channel.execute(b, { petId: 'one', body: 'while active session awaits approval' });
    await waitFor(() => outputs(f, b).length === 2);
    const stillWaiting = await host.interaction.snapshot();
    if (stillWaiting.type !== 'session.snapshot.result') throw Error('snapshot');
    assert.equal(stillWaiting.snapshot.session.pendingInterrupt?.interruptId, pending.interruptId);
    await host.interaction.request({ type: 'interrupt.resume', requestId: 'approve-a', interruptId: pending.interruptId,
      value: { decisions: [{ interactionId: 'approval', selectedOptionId: 'approve' }] } });
    await waitFor(() => outputs(f, a).length === 2);
    assert.deepEqual(outputs(f, a).map(m => m.body), ['Answer 1: approval', 'Answer 2: after approval']);
    assert.equal(f.channel.service.readExecutions(a).executions[0]!.state, 'completed');
    stop();
  } finally { await f.close(); await rm(root, { recursive: true, force: true }); }
});


test('concurrent first use reserves one session; queued targets survive a TUI switch and snapshots exclude background runs', async () => {
  const root = await mkdtemp(join(tmpdir(), 'channel-target-'));
  const f = await fixture(root);
  let release!: () => void;
  f.barrier.wait = new Promise<void>(resolve => { release = resolve; });
  try {
    const a = f.channel.service.createChannel(goal, human).channelId;
    const b = f.channel.service.createChannel(goal, human).channelId;
    await Promise.all([f.channel.execute(a, { petId: 'one', body: 'first' }), f.channel.execute(a, { petId: 'one', body: 'second' })]);
    await waitFor(() => f.active() === 1);
    const binding = f.channel.service.getBinding(a, 'one')!;
    const snapshot = await f.hosts[0]!.interaction.snapshot();
    if (snapshot.type !== 'session.snapshot.result') throw Error('snapshot');
    assert.equal(snapshot.snapshot.session.activeRun, null);
    await f.channel.execute(b, { petId: 'one', body: 'third' });
    const switched = f.hosts[0]!.interaction.request({ type: 'session.new', requestId: 'new-tui' });
    f.barrier.wait = undefined; release();
    await switched;
    await waitFor(() => outputs(f, a).length === 2 && outputs(f, b).length === 1);
    assert.deepEqual(f.calls.map(c => c.thread), [binding.sessionId, binding.sessionId, f.channel.service.getBinding(b, 'one')!.sessionId]);
    assert.equal(f.maxActive(), 1);
    await assert.rejects(f.hosts[0]!.resident.dispatch.dispatch({ request: 'wrong pet', session: { id: 'other:12345678', create: true } }), /identity/);
  } finally { release(); await f.close(); await rm(root, { recursive: true, force: true }); }
});

test('failed first admission keeps the reserved identity for retry; completed output replay is idempotent', async () => {
  const root = await mkdtemp(join(tmpdir(), 'channel-reservation-'));
  const file = join(root, 'channels.sqlite');
  let fail = true;
  const targets: string[] = [];
  let channel = createChannelPlugin({ databasePath: file, httpRoute: false });
  const create = () => createStudio({ studioId: 'retry', entryPetId: 'one', plugins: [channel], pets: [{
    registration: { petId: 'one', name: 'One' }, dispatch: {
      getQueueSnapshot: () => ({ state: 'open', activeOperation: null, queuedConversations: 0, queuedDispatches: 0 }),
      onQueueChange: () => () => {}, onDispatchLifecycle: () => () => {},
      dispatch: async (input) => { targets.push(input.session!.id); if (fail) throw Error('registration unavailable'); },
    },
  }] });
  let studio = await create();
  try {
    const id = channel.service.createChannel(goal, human).channelId;
    await assert.rejects(channel.execute(id, { petId: 'one', body: 'start' }), /unavailable/);
    const reserved = channel.service.getBinding(id, 'one')!;
    assert.equal(reserved.registered, false);
    await studio.shutdown();
    channel = createChannelPlugin({ databasePath: file, httpRoute: false });
    studio = await create(); fail = false;
    await channel.execute(id, { petId: 'one', body: 'retry' });
    assert.deepEqual(targets, [reserved.sessionId, reserved.sessionId]);
    assert.equal(channel.service.getBinding(id, 'one')!.registered, true);
    const source = { petId: 'one', sessionId: reserved.sessionId, invocationId: 'completed' };
    const first = channel.service.recordOutput(id, source, 'Which destination?');
    assert.deepEqual(channel.service.recordOutput(id, source, 'Which destination?'), first);
  } finally { await studio.shutdown(); await rm(root, { recursive: true, force: true }); }
});

test('a bound session alone does not publish; scope mismatch reports failure; native review is a read-only notice', async () => {
  const root = await mkdtemp(join(tmpdir(), 'channel-destination-'));
  const f = await fixture(root);
  const events: Array<{ type: string; payload?: unknown }> = [];
  f.studio.subscribe(event => { events.push(event); });
  try {
    assert.ok(!f.channel.toolkits.flatMap(t => t.tools).some(t => t.tool.name === 'channel_send_message'));
    const a = f.channel.service.createChannel(goal, human).channelId;
    const b = f.channel.service.createChannel(goal, human).channelId;
    const { binding } = await f.channel.execute(a, { petId: 'one', body: 'ask' });
    await waitFor(() => outputs(f, a).length === 1);
    const receipt = await f.studio.dispatch({ petId: 'one', request: 'not public', session: { id: binding.sessionId }, metadata: { channelId: a } });
    await waitFor(() => events.some(e => e.type === 'dispatch.completed' && (e.payload as any).invocationId === receipt.invocationId));
    assert.equal(outputs(f, a).length, 1);
    await f.studio.dispatch({ petId: 'one', request: 'wrong destination', session: { id: binding.sessionId }, scope: { namespace: 'channel', id: b } });
    await waitFor(() => events.some(e => e.type === 'channel.delivery_failed'));
    assert.equal(outputs(f, b).length, 0);
    assert.equal(outputs(f, a).length, 1);
    await f.channel.execute(b, { petId: 'one', body: 'approval' });
    await waitFor(() => f.channel.service.readInterruptNotifications(b).notifications.length === 1);
    assert.equal(f.channel.service.readInterruptNotifications(b).notifications[0]?.pendingInterrupt.payload.kind, 'human_review');
    assert.equal(outputs(f, b).length, 0);
    assert.ok(!JSON.stringify(f.channel.service.readContext(b)).includes('interruptId'));
  } finally { await f.close(); await rm(root, { recursive: true, force: true }); }
});

async function selectPending(f: Awaited<ReturnType<typeof fixture>>, channelId: string) {
  const binding = f.channel.service.getBinding(channelId, 'one')!;
  await f.hosts[0]!.interaction.request({ type: 'session.resume', requestId: 'select-pending', sessionId: binding.sessionId });
  const snapshot = await f.hosts[0]!.interaction.snapshot();
  if (snapshot.type !== 'session.snapshot.result') throw Error('snapshot');
  const pending = snapshot.snapshot.session.pendingInterrupt;
  assert.ok(pending);
  return pending;
}
const approve = (interruptId: string, requestId = 'approve') => ({ type: 'interrupt.resume' as const, requestId, interruptId,
  value: { decisions: [{ interactionId: 'approval', selectedOptionId: 'approve' }] } });

test('Host restart restores waiting invocation; duplicate approval and result replay publish only the original output', async () => {
  const root = await mkdtemp(join(tmpdir(), 'channel-resume-restart-'));
  let f = await fixture(root);
  try {
    const id = f.channel.service.createChannel(goal, human).channelId;
    const { receipt } = await f.channel.execute(id, { petId: 'one', body: 'approval' });
    await waitFor(() => f.channel.service.readExecutions(id).executions[0]?.state === 'waiting');
    await f.close();
    f = await fixture(root);
    const pending = await selectPending(f, id);
    await Promise.all([f.hosts[0]!.interaction.request(approve(pending.interruptId, 'resume-1')),
      f.hosts[0]!.interaction.request(approve(pending.interruptId, 'resume-duplicate'))]);
    await waitFor(() => outputs(f, id).length === 1);
    assert.equal(outputs(f, id)[0]!.source?.invocationId, receipt.invocationId);
    assert.equal(f.channel.service.readExecutions(id).executions[0]!.state, 'completed');
    assert.equal(f.calls.length, 1);
    f.hosts[0]!.resident.dispatch.replayDispatchLifecycle!();
    await f.close();
    f = await fixture(root);
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal(outputs(f, id).length, 1);
    assert.equal(f.calls.length, 0, 'recovery republishes settlement, never repeats execution');
    const record = JSON.parse(await readFile(buildHostRuntimeConfig(join(root, 'one')).tuiSessionPath, 'utf8')).invocations[receipt.invocationId];
    assert.equal(record.scope.id, id);
    assert.equal(record.pendingInterrupt, undefined);
    assert.equal(record.settlementId, `${receipt.invocationId}:settled`);
  } finally { await f.close(); await rm(root, { recursive: true, force: true }); }
});

test('approval runtime failure settles original Channel timeline while another Channel remains runnable', async () => {
  const root = await mkdtemp(join(tmpdir(), 'channel-resume-failure-'));
  const f = await fixture(root);
  try {
    const id = f.channel.service.createChannel(goal, human).channelId;
    await f.channel.execute(id, { petId: 'one', body: 'approval-failure' });
    await waitFor(() => f.channel.service.readExecutions(id).executions[0]?.state === 'waiting');
    const pending = await selectPending(f, id);
    await f.hosts[0]!.interaction.request(approve(pending.interruptId));
    await waitFor(() => f.channel.service.readExecutions(id).executions[0]?.state === 'failed');
    assert.match(f.channel.service.readExecutions(id).executions[0]!.error!, /deterministic resume failure/);
    assert.equal(outputs(f, id).length, 0);
    const other = f.channel.service.createChannel(goal, human).channelId;
    await f.channel.execute(other, { petId: 'one', body: 'next' });
    await waitFor(() => outputs(f, other).length === 1);
    assert.equal(f.channel.service.readExecutions(other).executions[0]!.state, 'completed');
  } finally { await f.close(); await rm(root, { recursive: true, force: true }); }
});

for (const decision of ['cancel', 'reject'] as const) {
  test(`${decision} resolves original invocation without stale pending state or cross-Channel delivery`, async () => {
    const root = await mkdtemp(join(tmpdir(), `channel-resume-${decision}-`));
    const f = await fixture(root);
    try {
      const id = f.channel.service.createChannel(goal, human).channelId;
      const other = f.channel.service.createChannel(goal, human).channelId;
      await f.channel.execute(id, { petId: 'one', body: 'approval-cancel' });
      await waitFor(() => f.channel.service.readExecutions(id).executions[0]?.state === 'waiting');
      const pending = await selectPending(f, id);
      await f.hosts[0]!.interaction.request({ type: 'interrupt.resume', requestId: decision, interruptId: pending.interruptId,
        value: decision === 'cancel' ? { action: 'cancel' } : { decisions: [{ interactionId: 'approval', selectedOptionId: 'reject' }] } });
      await waitFor(() => f.channel.service.readExecutions(id).executions[0]?.state === 'completed');
      assert.equal(outputs(f, id)[0]!.body, 'Action withdrawn.');
      assert.equal(outputs(f, other).length, 0);
      await f.channel.execute(id, { petId: 'one', body: 'next' });
      await waitFor(() => outputs(f, id).length === 2);
      const snapshot = await f.hosts[0]!.interaction.snapshot();
      if (snapshot.type !== 'session.snapshot.result') throw Error('snapshot');
      assert.equal(snapshot.snapshot.session.pendingInterrupt, null);
      assert.equal(f.maxActive(), 1);
    } finally { await f.close(); await rm(root, { recursive: true, force: true }); }
  });
}

test('mismatched durable runtime identity blocks recovery and cannot inherit a Channel scope', async () => {
  const root = await mkdtemp(join(tmpdir(), 'channel-resume-mismatch-'));
  let f = await fixture(root);
  try {
    const id = f.channel.service.createChannel(goal, human).channelId;
    const { receipt } = await f.channel.execute(id, { petId: 'one', body: 'approval' });
    await waitFor(() => f.channel.service.readExecutions(id).executions[0]?.state === 'waiting');
    await f.close();
    const file = buildHostRuntimeConfig(join(root, 'one')).tuiSessionPath;
    const data = JSON.parse(await readFile(file, 'utf8'));
    data.invocations[receipt.invocationId].runtime.runId = 'different-run';
    await writeFile(file, JSON.stringify(data));
    f = await fixture(root);
    await waitFor(() => f.channel.service.readExecutions(id).executions[0]?.state === 'failed');
    const pending = await selectPending(f, id);
    await f.hosts[0]!.interaction.request(approve(pending.interruptId));
    assert.equal(f.calls.length, 0);
    assert.equal(outputs(f, id).length, 0);
    assert.equal(JSON.parse(await readFile(file, 'utf8')).invocations[receipt.invocationId].state, 'blocked');
  } finally { await f.close(); await rm(root, { recursive: true, force: true }); }
});

test('ordinary interactive messages in a bound session never become Channel output', async () => {
  const root = await mkdtemp(join(tmpdir(), 'channel-interactive-isolation-'));
  const f = await fixture(root);
  try {
    const id = f.channel.service.createChannel(goal, human).channelId;
    const { binding } = await f.channel.execute(id, { petId: 'one', body: 'ask' });
    await waitFor(() => outputs(f, id).length === 1);
    await f.hosts[0]!.interaction.request({ type: 'session.resume', requestId: 'select', sessionId: binding.sessionId });
    await f.hosts[0]!.interaction.request({ type: 'chat_request', requestId: 'private', message: 'ordinary conversation' });
    assert.equal(outputs(f, id).length, 1);
    assert.equal(f.calls.at(-1)!.thread, 'tui');
  } finally { await f.close(); await rm(root, { recursive: true, force: true }); }
});

test('restart reconciles a completed runtime after Host settlement loss without executing again', async () => {
  const root = await mkdtemp(join(tmpdir(), 'channel-settlement-reconcile-'));
  let f = await fixture(root);
  try {
    const id = f.channel.service.createChannel(goal, human).channelId;
    const { receipt } = await f.channel.execute(id, { petId: 'one', body: 'approval' });
    await waitFor(() => f.channel.service.readExecutions(id).executions[0]?.state === 'waiting');
    const file = buildHostRuntimeConfig(join(root, 'one')).tuiSessionPath;
    const before = JSON.parse(await readFile(file, 'utf8'));
    const pending = await selectPending(f, id);
    await f.hosts[0]!.interaction.request(approve(pending.interruptId));
    await waitFor(() => outputs(f, id).length === 1);
    await f.close();
    // Fault injection only in Host state: runtime checkpoints are untouched.
    const saved = JSON.parse(await readFile(file, 'utf8'));
    saved.invocations[receipt.invocationId] = before.invocations[receipt.invocationId];
    await writeFile(file, JSON.stringify(saved));
    f = await fixture(root);
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal(f.calls.length, 0);
    assert.equal(outputs(f, id).length, 1);
    const recovered = JSON.parse(await readFile(file, 'utf8')).invocations[receipt.invocationId];
    assert.equal(recovered.state, 'completed');
    assert.equal(recovered.reply, 'Answer 1: approval');
  } finally { await f.close(); await rm(root, { recursive: true, force: true }); }
});

test('durable Studio idempotency returns the first invocation after restart and rejects a changed request', async () => {
  const root = await mkdtemp(join(tmpdir(), 'channel-durable-idempotency-'));
  let f = await fixture(root);
  try {
    const id = f.channel.service.createChannel(goal, human).channelId;
    const { binding } = await f.channel.execute(id, { petId: 'one', body: 'ask' });
    await waitFor(() => outputs(f, id).length === 1);
    const request = { petId: 'one', request: 'idempotent task', session: { id: binding.sessionId },
      scope: { namespace: 'channel', id }, idempotencyKey: 'stable-request' };
    const receipt = await f.studio.dispatch(request);
    await waitFor(() => outputs(f, id).length === 2);
    await f.close();
    f = await fixture(root);
    assert.equal((await f.studio.dispatch(request)).invocationId, receipt.invocationId);
    await assert.rejects(f.studio.dispatch({ ...request, request: 'changed task' }), /identity conflict/);
    assert.equal(f.calls.length, 0);
    assert.equal(outputs(f, id).length, 2);
  } finally { await f.close(); await rm(root, { recursive: true, force: true }); }
});
