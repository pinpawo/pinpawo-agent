import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Annotation, Command, END, START, StateGraph, interrupt } from '@langchain/langgraph';
import { AIMessage, type BaseMessage } from '@langchain/core/messages';
import { buildReviewSpec, readPendingInterrupt } from '@pinpawo/pet-agent';
import { createChannelPlugin, type ChannelMessage } from '@pinpawo-plugin/channel';
import { createStudio } from '@pinpawo/studio';
import { buildHostRuntimeConfig, createResidentPetHost, FileSaver, readPetInvocationContext } from 'pinpawo/host-runtime';
import { createTestModelProfiles } from '../../../services/host/src/testing/modelProfiles';
import { HostToolkitInventoryStore } from '../../../services/host/src/toolkits/toolkitInventory';
import type { AgentChannelSetup } from '../../../services/host/src/agent/agentChannel';
import type { InterruptResume } from '../../../services/host/src/agent/agentGraphService';

async function waitFor(done: () => boolean) {
  for (let attempt = 0; attempt < 400; attempt++) {
    if (done()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('Approval test timed out.');
}

/** Real persisted LangGraph interrupts and production turn/approval handlers; no model calls. */
async function fixture(sameNode = false) {
  const root = await mkdtemp(join(tmpdir(), 'channel-approval-'));
  const plugin = createChannelPlugin({ httpRoute: false });
  const read = plugin.toolkits[0]!.tools.find((entry) => entry.tool.name === 'channel_read_context')!.tool;
  const send = plugin.toolkits[0]!.tools.find((entry) => entry.tool.name === 'channel_send_message')!.tool;
  const deliveries: ChannelMessage[] = [];
  const scopes: unknown[] = [];
  const hosts: Awaited<ReturnType<typeof createResidentPetHost>>[] = [];
  const inputs: Array<{ channel: { channelId: string; scope: string } }> = [];
  const State = Annotation.Root({ messages: Annotation<BaseMessage[]>({ reducer: (a, b) => [...a, ...b], default: () => [] }) });
  for (const petId of ['executor', 'reviewer']) {
    const runtimeConfig = buildHostRuntimeConfig(join(root, petId));
    const checkpointer = new FileSaver(runtimeConfig.checkpointPath);
    const approve = (step: number, deliver = true) => async () => {
      const review = buildReviewSpec({ id: `${petId}-${step}`, view: { kind: 'plain', body: 'Approve this test delivery?' },
        options: [{ id: 'approve', label: 'Approve', decision: { type: 'approve' } }],
      });
      const response = interrupt({ kind: 'review', review }) as { action?: string; decisions?: Array<{ selectedOptionId: string }> };
      if (response.action === 'interrupt_run') return { messages: [new AIMessage('Cancelled')] };
      assert.equal(response.decisions?.[0]?.selectedOptionId, 'approve');
      if (!deliver) return { messages: [] };
      scopes.push(readPetInvocationContext());
      inputs.push(JSON.parse(await read.invoke({}) as string));
      deliveries.push(JSON.parse(await send.invoke({ body: `approved ${step}` }) as string));
      return { messages: [new AIMessage(`Delivered ${step}`)] };
    };
    const builder = new StateGraph(State).addNode('first', sameNode ? async () => {
      const first = await approve(1, false)();
      return first.messages.at(-1)?.text === 'Cancelled' ? first : approve(2)();
    } : approve(1)).addEdge(START, 'first');
    const graph = builder.addNode('second', approve(2))
      .addConditionalEdges('first', (state) => sameNode || state.messages.at(-1)?.text === 'Cancelled' ? END : 'second')
      .addEdge('second', END).compile({ checkpointer });
    const config = (setup: AgentChannelSetup) => ({ configurable: { thread_id: setup.input.threadId } });
    const graphService = {
      async readThreadState(setup: AgentChannelSetup) {
        const snapshot = await graph.getState(config(setup));
        return { messages: snapshot.values.messages ?? [], pendingInterrupt: readPendingInterrupt(snapshot),
          checkpointId: snapshot.config?.configurable?.checkpoint_id, acceptsResume: snapshot.next.length > 0 || snapshot.tasks.length > 0, currentPlan: null };
      },
      async streamEvents(setup: AgentChannelSetup, resume?: InterruptResume) {
        return graph.streamEvents(resume ? new Command({ resume: { [resume.interruptId]: resume.value } }) : { messages: setup.input.messages },
          { ...config(setup), version: 'v3' });
      },
    };
    const host = await createResidentPetHost({
      petId, petName: petId, runtimeConfig, modelProfiles: createTestModelProfiles(),
      globalReviewPolicyMode: 'require_authorization', autoAuthorizationSafetyLevel: 'strict', capabilities: [],
      toolkitInventory: new HostToolkitInventoryStore(), checkpointer, sessionStatePath: runtimeConfig.tuiSessionPath,
      capabilityArtifactStore: { writeArtifact: async () => { throw new Error('unused'); }, readArtifact: async () => { throw new Error('unused'); },
        listArtifacts: async () => [], deleteThreadArtifacts: async () => {}, getDownloadUri: async (uri) => uri },
      graphService: graphService as never,
      // Use the real runAgentSessionTurn, including graph stream settlement.
    });
    hosts.push(host);
  }
  const studio = await createStudio({ studioId: 'approvals', entryPetId: 'executor', plugins: [plugin],
    pets: hosts.map((host, index) => ({ registration: { petId: index ? 'reviewer' : 'executor', name: 'Pet' }, dispatch: host.resident.dispatch })),
  });
  const channels = ['A', 'B'].map((title) => plugin.service.createChannel({ title, goal: `${title} goal`, scope: `${title} scope` }, { kind: 'human', id: 'owner' }));
  async function pending(index: number) {
    const snapshot = await hosts[index]!.interaction.snapshot();
    assert.equal(snapshot.type, 'session.snapshot.result');
    if (snapshot.type !== 'session.snapshot.result') throw new Error('missing snapshot');
    const value = snapshot.snapshot.session?.pendingInterrupt;
    assert.ok(value); assert.equal(value.payload.kind, 'human_review');
    return value;
  }
  const answer = (index: number, interruptId: string, interactionId: string, requestId: string) => hosts[index]!.interaction.request({
    type: 'interrupt.resume', requestId, interruptId, value: { decisions: [{ interactionId, selectedOptionId: 'approve' }] },
  });
  return { plugin, studio, hosts, deliveries, inputs, scopes, channels, pending, answer,
    close: async () => { await Promise.all(hosts.map((h) => h.close())); await studio.shutdown(); await rm(root, { recursive: true, force: true }); } };
}

test('approval checkpoint → reconnect → validated resume restores original Channel and author through two approvals', async () => {
  const f = await fixture();
  try {
    const channel = f.channels[0]!;
    const receipt = await f.studio.dispatch({ petId: 'executor', request: 'Deliver after approvals', scope: { namespace: 'channel', id: channel.channelId } });
    await waitFor(() => f.hosts[0]!.resident.dispatch.getQueueSnapshot().state === 'waiting');
    const first = await f.pending(0);
    assert.equal(f.deliveries.length, 0);
    const connection = { isConnected: () => true, send: () => true };
    await f.hosts[0]!.interaction.connect(connection); await f.hosts[0]!.interaction.disconnect(connection);
    await f.answer(0, 'wrong-id', 'executor-1', 'wrong-id');
    await f.answer(0, first.interruptId, 'wrong-review', 'wrong-review');
    await f.hosts[0]!.interaction.request({ type: 'interrupt.resume', requestId: 'forged', interruptId: first.interruptId,
      value: { decisions: [{ interactionId: 'executor-1', selectedOptionId: 'approve' }], scope: { namespace: 'channel', id: f.channels[1]!.channelId } } });
    await f.hosts[0]!.interaction.request({ type: 'chat_request', requestId: 'ordinary', message: 'Switch to Channel B' });
    assert.equal(f.deliveries.length, 0);
    f.plugin.service.reviseChannel(channel.channelId, { title: 'A', goal: 'A goal', scope: 'Updated while waiting', expectedRevision: channel.sequence, reason: 'User revision' }, { kind: 'human', id: 'owner' });
    await f.answer(0, first.interruptId, 'executor-1', 'approve-first');
    assert.equal(f.deliveries.length, 1);
    const second = await f.pending(0);
    assert.notEqual(second.interruptId, first.interruptId);
    await f.answer(0, first.interruptId, 'executor-1', 'replay-first');
    assert.equal(f.deliveries.length, 1);
    await f.answer(0, second.interruptId, 'executor-2', 'approve-second');
    assert.equal(f.hosts[0]!.resident.dispatch.getQueueSnapshot().state, 'open');
    await f.answer(0, second.interruptId, 'executor-2', 'replay-ended');
    assert.equal(f.deliveries.length, 2);
    for (const message of f.deliveries) {
      assert.equal(message.channelId, channel.channelId); assert.deepEqual(message.author, { kind: 'pet', id: 'executor' });
    }
    assert.deepEqual(f.scopes, [1, 2].map(() => ({ petId: 'executor', dispatchId: receipt.invocationId, scope: { namespace: 'channel', id: channel.channelId } })));
    assert.equal(f.inputs[0]?.channel.scope, 'Updated while waiting');
    assert.equal(f.plugin.service.readHistory(f.channels[1]!.channelId).entries.length, 1);
    assert.equal(readPetInvocationContext(), undefined);
  } finally { await f.close(); }
});

test('cross-Pet approvals, cancelled invocations and a later Channel cannot borrow prior identity', async () => {
  const f = await fixture();
  try {
    for (const [index, petId] of ['executor', 'reviewer'].entries()) await f.studio.dispatch({ petId, request: 'Review', scope: { namespace: 'channel', id: f.channels[index]!.channelId } });
    await waitFor(() => f.hosts.every((h) => h.resident.dispatch.getQueueSnapshot().state === 'waiting'));
    const a = await f.pending(0); const b = await f.pending(1);
    await f.answer(1, a.interruptId, 'executor-1', 'cross-pet');
    assert.equal(f.deliveries.length, 0);
    await f.hosts[0]!.interaction.request({ type: 'interrupt.resume', requestId: 'cancel', interruptId: a.interruptId, value: { action: 'cancel' } });
    assert.equal(f.hosts[0]!.resident.dispatch.getQueueSnapshot().state, 'open');
    await f.answer(0, a.interruptId, 'executor-1', 'cancelled-replay');
    await f.studio.dispatch({ petId: 'executor', request: 'New Channel', scope: { namespace: 'channel', id: f.channels[1]!.channelId } });
    await waitFor(() => f.hosts[0]!.resident.dispatch.getQueueSnapshot().state === 'waiting');
    const later = await f.pending(0);
    await f.answer(0, a.interruptId, 'executor-1', 'old-channel-replay');
    await f.answer(0, later.interruptId, 'executor-1', 'new-channel-approve');
    await f.answer(1, b.interruptId, 'reviewer-1', 'other-pet-approve');
    assert.deepEqual(f.deliveries.map((m) => [m.channelId, m.author.id]), [[f.channels[1]!.channelId, 'executor'], [f.channels[1]!.channelId, 'reviewer']]);
    assert.equal(f.plugin.service.readHistory(f.channels[0]!.channelId).entries.length, 1);
  } finally { await f.close(); }
});


test('distinct approvals within one checkpoint retain identity without accepting the earlier review again', async () => {
  const f = await fixture(true);
  try {
    const receipt = await f.studio.dispatch({ petId: 'executor', request: 'Two approvals in one node',
      scope: { namespace: 'channel', id: f.channels[0]!.channelId } });
    await waitFor(() => f.hosts[0]!.resident.dispatch.getQueueSnapshot().state === 'waiting');
    const first = await f.pending(0);
    await f.answer(0, first.interruptId, 'executor-1', 'first');
    const second = await f.pending(0);
    assert.equal(f.deliveries.length, 0);
    await f.answer(0, second.interruptId, 'executor-1', 'replayed-review');
    assert.equal(f.deliveries.length, 0);
    await f.answer(0, second.interruptId, 'executor-2', 'second');
    assert.equal(f.deliveries.length, 1);
    assert.deepEqual(f.scopes, [{ petId: 'executor', dispatchId: receipt.invocationId,
      scope: { namespace: 'channel', id: f.channels[0]!.channelId } }]);
  } finally { await f.close(); }
});
