import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { AIMessage, ToolMessage, type BaseMessage } from '@langchain/core/messages';
import { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import { defineInstructionDocument } from '@pinpawo/pet-agent';
import { createChannelPlugin, type HeadInput } from '@pinpawo-plugin/channel';
import { channelDispatchInput } from '../../../plugins/channel/src/channelDispatchInput';
import { buildHostRuntimeConfig, createResidentPetHost, FileSaver } from 'pinpawo/host-runtime';
import { HostGraphService } from '../../../services/host/src/agent/agentGraphService';
import type { AgentChannelSetup } from '../../../services/host/src/agent/agentChannel';
import { createTestModelProfiles } from '../../../services/host/src/testing/modelProfiles';
import { buildHostToolkitInventory, HostToolkitInventoryStore } from '../../../services/host/src/toolkits/toolkitInventory';
import { createStudioWithPets } from '../../support/livePets';
import { readChannelTestBatch, readChannelTestInput } from '../../support/channelDispatchInput';
import { createInvocationContextBridge } from './invocationContextBridge';

class ScriptedModel extends BaseChatModel {
  private calls = 0;
  constructor(private readonly respond: (messages: BaseMessage[], index: number) => AIMessage | Promise<AIMessage>) { super({}); }
  _llmType() { return 'channel-incoming-input-test'; }
  bindTools() { return this; }
  async _generate(messages: BaseMessage[]) {
    const message = await this.respond(messages, this.calls++);
    return { generations: [{ message, text: message.text }] };
  }
}

const call = (name: string, args: Record<string, unknown>, id: string) =>
  new AIMessage({ content: '', tool_calls: [{ name, args, id, type: 'tool_call' }] });

async function waitFor(done: () => boolean | Promise<boolean>) {
  for (let i = 0; i < 1000; i++) {
    if (await done()) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error('Incoming Channel input did not settle.');
}

for (const delivery of ['boundary', 'interrupt'] as const) {
  test(`Channel input continues the saved plan after ${delivery} without duplicate public delivery`, async () => {
    const root = await mkdtemp(join(tmpdir(), 'channel-incoming-'));
    const announcement = randomUUID(), update = randomUUID(), final = randomUUID(), focus = randomUUID();
    const me = { kind: 'human' as const, id: 'local' };
    const decisions: HeadInput[] = [];
    const channel = createChannelPlugin({ httpRoute: false, routing: { enabled: true, cooldownMs: 0 },
      headDecider: async input => {
        decisions.push(input);
        const dispatch = input.pet.participantId === 'pet:worker'
          && !input.messages.some(message => message.body === final);
        return { action: dispatch ? 'dispatch' : 'skip', confidence: 1, reason: '', reply: '',
          focus: dispatch && input.messages.some(message => message.body === update) ? focus : '' };
      },
    });
    const bridge = createInvocationContextBridge();
    const lifecycle: Array<{ state: string; dispatchId: string }> = [];
    let host: Awaited<ReturnType<typeof createResidentPetHost>> | undefined;
    let studio: Awaited<ReturnType<typeof createStudioWithPets>> | undefined;
    let started = false, aborted = false, toolCalls = 0, entryCalls = 0;
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    const probe = tool(async (_input, config) => {
      toolCalls++;
      started = true;
      await new Promise<void>((resolve, reject) => {
        const abort = () => { aborted = true; reject(config.signal?.reason ?? new Error('Aborted')); };
        config.signal?.addEventListener('abort', abort, { once: true });
        if (config.signal?.aborted) abort();
        void held.then(resolve).finally(() => config.signal?.removeEventListener('abort', abort));
      });
      return 'A factual completed delivery.';
    }, { name: 'probe', description: 'Perform the controlled work.', schema: z.object({}) });
    try {
      const inventory = await buildHostToolkitInventory({ sources: [
        { id: 'channel', kind: 'plugin', definitions: channel.toolkits },
        { id: 'probe', kind: 'plugin', definitions: [{ name: 'probe', description: 'Controlled work.', tools: [{ tool: probe }] }] },
      ] });
      const entry = new ScriptedModel(messages => {
        entryCalls++;
        const current = [...messages].reverse().find(message => message._getType() === 'human')!;
        const batch = entryCalls === 1 || delivery === 'boundary' ? readChannelTestBatch(current.text) : undefined;
        const input = batch ? batch.messages[0]! : readChannelTestInput(current.text);
        if (batch) assert.equal(batch.messages.length, 1);
        assert.equal(messages[0]!._getType(), 'system');
        assert.equal(messages[0]!.text.split(announcement).length - 1, 1);
        assert.ok(messages.slice(1).every(message => !message.text.includes(announcement)));
        if (entryCalls === 1) {
          assert.equal(batch?.petParticipantId, 'pet:worker');
          assert.equal(batch?.contextHint?.source, 'channel-head');
          assert.equal(batch?.contextHint?.action, 'read-latest-channel');
          return call('plan_request', { goal: 'Perform controlled work and reconcile delivery.' }, 'initial-plan');
        }
        assert.equal(entryCalls, 2, 'the additional input executes once');
        assert.equal(input.author.kind, 'pet', 'continuation preserves the actual source');
        assert.equal(input.author.participantId, 'pet:reviewer');
        assert.equal(input.body, update);
        if (delivery === 'boundary') {
          assert.equal(batch?.petParticipantId, 'pet:worker');
          assert.equal(batch?.contextHint?.focus, focus, 'dynamic focus reaches the real Entry model');
        }
        return call('continue', {}, 'continue-input');
      });
      const supervisor = new ScriptedModel((messages, index) => {
        if (index === 0) return call('submit_plan', { tasks: [{ capability: 'inspect', objective: 'Perform controlled work.' }] }, 'plan');
        if (index === 1) return call('delegate_capability', { briefing: 'Perform controlled work.' }, 'delegate');
        assert.ok(messages.some(message => message._getType() === 'human' && message.text.includes(update)),
          'the next Supervisor sees the new Channel input');
        if (delivery === 'boundary') {
          assert.ok(messages.some(message => message._getType() === 'human'
            && message.text.includes(update) && message.text.includes(focus)),
            'the Supervisor receives the same Head focus with the incoming message');
          assert.ok(messages.filter(message => message._getType() === 'system').every(message => !message.text.includes(focus)),
            'a Head suggestion does not become system authority');
        }
        const result = [...messages].reverse().find(message => ToolMessage.isInstance(message) && message.name === 'delegate_capability');
        if (delivery === 'boundary') {
          assert.ok(result, 'the completed delivery survives checkpoint and continuation');
          if (index === 2) return call('review_current', { completed: true, reason: 'The completed result and new review are available.' }, 'accept');
          assert.equal(index, 3);
        } else {
          assert.ok(!result, 'cancelled work is not represented as a returned delivery');
          assert.equal(index, 2);
        }
        return new AIMessage(final);
      });
      const child = new ScriptedModel((_messages, index) => index === 0
        ? call('probe', {}, 'probe-call') : new AIMessage('A factual completed delivery.'));
      const config = buildHostRuntimeConfig(root);
      const graph = new HostGraphService();
      const modelSetup = (setup: AgentChannelSetup): AgentChannelSetup => ({ ...setup,
        graphConfig: { ...setup.graphConfig, models: { act: supervisor, answer: entry, subagent: child } },
      });
      host = await createResidentPetHost({ petId: 'worker', petName: 'Worker', runtimeConfig: config,
        resolveInvocationContext: bridge.resolveInvocationContext, modelProfiles: createTestModelProfiles(),
        capabilities: [{ name: 'inspect', description: 'Perform controlled work.', uses: ['probe', 'channel'],
          instructions: defineInstructionDocument({ content: 'Perform the requested controlled work.' }) }],
        toolAuthorizationMode: 'full_access', autoAuthorizationSafetyLevel: 'strict',
        toolkitInventory: new HostToolkitInventoryStore(inventory), checkpointer: new FileSaver(config.checkpointPath),
        sessionStatePath: config.tuiSessionPath,
        graphService: {
          readThreadState: (setup: AgentChannelSetup) => graph.readThreadState(modelSetup(setup)),
          settleAbortedRun: (setup: AgentChannelSetup) => graph.settleAbortedRun(modelSetup(setup)),
          streamEvents: (setup: AgentChannelSetup) => graph.streamEvents(modelSetup(setup)),
        } as never,
      });
      host.resident.dispatch.onDispatchLifecycle(event => lifecycle.push({ state: event.state, dispatchId: event.dispatchId }));
      studio = await createStudioWithPets({ studioId: 'incoming', plugins: [channel],
        onPreparedContextResolver: bridge.onPreparedContextResolver,
        storage: { kind: 'sqlite', path: join(root, 'studio.sqlite') },
        pets: [{ registration: { petId: 'worker', name: 'Worker' }, dispatch: host.resident.dispatch, sessions: host.sessions },
          { registration: { petId: 'reviewer', name: 'Reviewer' }, dispatch: {
            getQueueSnapshot: () => ({ state: 'open', activeOperation: null, queuedConversations: 0, queuedDispatches: 0 }),
            onQueueChange: () => () => {}, onDispatchLifecycle: () => () => {}, dispatch: async () => {},
          } }],
      });
      const cid = (await channel.service.createChannel(me, { title: 'Incoming input', prompt: announcement,
        pets: ['worker', 'reviewer'] }, { studio: true })).channel.channelId;
      const initial = (await channel.sendMessage(cid, { body: 'Start the controlled work.' }, me)).message;
      await waitFor(() => started);
      assert.equal(decisions.find(input => input.pet.participantId === 'pet:worker')?.execution.state, 'unknown',
        'the initial Head decision does not infer execution from absent Channel bindings');
      if (delivery === 'boundary') {
        const reviewer = await channel.run(cid, 'reviewer', 'Return the controlled review.', { kind: 'trigger', id: 'test-review' });
        studio.notify({ source: 'resident-pet', type: 'dispatch.message', occurredAt: new Date().toISOString(),
          payload: { petId: 'reviewer', invocationId: reviewer.invocationId, sessionId: reviewer.sessionId,
            scope: { namespace: 'channel', id: cid },
            message: { type: 'message.completed', messageId: 'review-result', role: 'assistant', text: update } },
        });
        await waitFor(() => host!.resident.dispatch.getQueueSnapshot().queuedDispatches === 1);
        const decision = decisions.filter(input => input.pet.participantId === 'pet:worker'
          && input.messages.some(message => message.body === update));
        assert.equal(decision.length, 1, 'the incoming reply makes one decision for its eligible Pet');
        assert.equal(decision[0]!.execution.state, 'running');
        assert.deepEqual(decision[0]!.execution.runs?.flatMap(run => run.requestMessages),
          [{ messageId: initial.messageId, occurredAt: initial.occurredAt }]);
        assert.ok(decision[0]!.execution.runs?.every(run => Date.parse(run.startedAt) <= Date.parse(decision[0]!.currentTime)));
        assert.equal(aborted, false, 'ordinary input waits for the delegation');
        assert.equal(entryCalls, 1);
        release();
      } else {
        const message = (await channel.service.postMessage({ kind: 'pet', id: 'reviewer' }, cid, { body: update, mentions: [{ participantId: 'pet:worker' }] })).message;
        const binding = await channel.service.getSession(cid, 'worker');
        assert.ok(binding);
        await studio.dispatch({ petId: 'worker', request: channelDispatchInput(message),
          session: { id: binding.sessionId }, scope: { namespace: 'channel', id: cid }, delivery: 'interrupt' });
      }
      await waitFor(async () => (await channel.service.readContext(me, cid)).messages.some(message => message.body === final));
      await waitFor(() => host!.resident.dispatch.getQueueSnapshot().state === 'open');
      await waitFor(() => decisions.some(input => input.messages.some(message => message.body === final)));
      const messages = (await channel.service.readContext(me, cid)).messages;
      assert.deepEqual(messages.filter(message => message.author.id === 'worker').map(message => message.body), [final]);
      const finalDecisions = decisions.filter(input => input.messages.some(message => message.body === final));
      assert.equal(finalDecisions.length, 1, 'the final acknowledgement is considered once and stops');
      assert.equal(finalDecisions[0]!.pet.participantId, 'pet:reviewer', 'own output does not trigger the worker Head');
      if (delivery === 'boundary') {
        const routedReview = decisions.filter(input => input.messages.some(message => message.body === update));
        assert.equal(routedReview.length, 1);
        assert.equal(routedReview[0]!.messages[0]!.author.participantId, 'pet:reviewer');
        assert.equal(routedReview[0]!.messages[0]!.author.kind, 'pet');
        assert.equal(routedReview[0]!.pet.participantId, 'pet:worker');
        assert.deepEqual(messages.find(message => message.body === update)?.mentions, []);
      }
      assert.equal(toolCalls, 1, 'continuing does not replay the earlier tool');
      assert.equal(aborted, delivery === 'interrupt');
      assert.equal(lifecycle.filter(event => event.state === 'running').length, 2);
      assert.equal(lifecycle.filter(event => event.state === 'interrupted').length, 1);
      assert.equal(lifecycle.filter(event => event.state === 'completed').length, 1);
      assert.equal(lifecycle.filter(event => event.state === 'message').length, 1, 'one invocation owns the public reply');
    } finally {
      release();
      await host?.close();
      await studio?.shutdown();
      await rm(root, { recursive: true, force: true });
    }
  });
}
