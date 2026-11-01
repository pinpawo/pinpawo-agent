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
import { createChannelPlugin } from '@pinpawo-plugin/channel';
import { channelDispatchInput } from '../../../plugins/channel/src/channelDispatchInput';
import { buildHostRuntimeConfig, createResidentPetHost, FileSaver } from 'pinpawo/host-runtime';
import { HostGraphService } from '../../../services/host/src/agent/agentGraphService';
import type { AgentChannelSetup } from '../../../services/host/src/agent/agentChannel';
import { createTestModelProfiles } from '../../../services/host/src/testing/modelProfiles';
import { buildHostToolkitInventory, HostToolkitInventoryStore } from '../../../services/host/src/toolkits/toolkitInventory';
import { createStudioWithPets } from '../../support/livePets';
import { readChannelTestInput } from '../../support/channelDispatchInput';
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
    const announcement = randomUUID(), update = randomUUID(), final = randomUUID();
    const me = { kind: 'human' as const, id: 'local' };
    const channel = createChannelPlugin({ httpRoute: false, routing: { enabled: true },
      routeDecider: async () => ({ target: 'pet:worker', confidence: 1 }),
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
        const input = readChannelTestInput(current.text);
        assert.equal(messages[0]!._getType(), 'system');
        assert.equal(messages[0]!.text.split(announcement).length - 1, 1);
        assert.ok(messages.slice(1).every(message => !message.text.includes(announcement)));
        if (entryCalls === 1) {
          assert.equal(input.addressedBy, 'routing');
          assert.equal(input.contextHint?.action, 'read-latest-channel');
          return call('plan_request', { goal: 'Perform controlled work and reconcile delivery.' }, 'initial-plan');
        }
        assert.equal(entryCalls, 2, 'the additional input executes once');
        assert.equal(input.author.kind, 'pet', 'continuation preserves the actual source');
        assert.equal(input.author.participantId, 'pet:reviewer');
        assert.equal(input.body, update);
        return call('continue', {}, 'continue-input');
      });
      const supervisor = new ScriptedModel((messages, index) => {
        if (index === 0) return call('submit_plan', { tasks: [{ capability: 'inspect', objective: 'Perform controlled work.' }] }, 'plan');
        if (index === 1) return call('delegate_capability', { briefing: 'Perform controlled work.' }, 'delegate');
        assert.ok(messages.some(message => message._getType() === 'human' && message.text.includes(update)),
          'the next Supervisor sees the new Channel input');
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
        capabilityArtifactStore: { writeArtifact: async () => { throw Error('unused'); }, readArtifact: async () => { throw Error('unused'); },
          listArtifacts: async () => [], deleteThreadArtifacts: async () => {}, getDownloadUri: async uri => uri },
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
        pets: [{ registration: { petId: 'worker', name: 'Worker' }, dispatch: host.resident.dispatch },
          { registration: { petId: 'reviewer', name: 'Reviewer' }, dispatch: {
            getQueueSnapshot: () => ({ state: 'open', activeOperation: null, queuedConversations: 0, queuedDispatches: 0 }),
            onQueueChange: () => () => {}, onDispatchLifecycle: () => () => {}, dispatch: async () => {},
          } }],
      });
      const cid = (await channel.service.createChannel(me, { title: 'Incoming input', prompt: announcement,
        pets: ['worker', 'reviewer'] }, { studio: true })).channel.channelId;
      await channel.sendMessage(cid, { body: 'Start the controlled work.' }, me);
      await waitFor(() => started);
      if (delivery === 'boundary') {
        await channel.sendMessage(cid, { body: update, mentions: [{ participantId: 'pet:worker' }] }, { kind: 'pet', id: 'reviewer' });
        assert.equal(aborted, false, 'ordinary input waits for the delegation');
        assert.equal(entryCalls, 1);
        release();
      } else {
        const message = (await channel.service.postMessage({ kind: 'pet', id: 'reviewer' }, cid, { body: update })).message;
        const binding = await channel.service.getSession(cid, 'worker');
        assert.ok(binding);
        await studio.dispatch({ petId: 'worker', request: channelDispatchInput(message),
          session: { id: binding.sessionId }, scope: { namespace: 'channel', id: cid }, delivery: 'interrupt' });
      }
      await waitFor(async () => (await channel.service.readContext(me, cid)).messages.some(message => message.body === final));
      await waitFor(() => host!.resident.dispatch.getQueueSnapshot().state === 'open');
      const messages = (await channel.service.readContext(me, cid)).messages;
      assert.deepEqual(messages.filter(message => message.author.id === 'worker').map(message => message.body), [final]);
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
