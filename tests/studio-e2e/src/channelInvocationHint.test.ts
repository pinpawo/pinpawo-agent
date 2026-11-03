import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { AIMessage, ToolMessage, type BaseMessage } from '@langchain/core/messages';
import { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { defineInstructionDocument, type AgentInvocationHint } from '@pinpawo/pet-agent';
import { createChannelPlugin } from '@pinpawo-plugin/channel';
import { buildHostRuntimeConfig, createResidentPetHost, FileSaver } from 'pinpawo/host-runtime';
import { HostGraphService } from '../../../services/host/src/agent/agentGraphService';
import type { AgentChannelSetup } from '../../../services/host/src/agent/agentChannel';
import { createTestModelProfiles } from '../../../services/host/src/testing/modelProfiles';
import { buildHostToolkitInventory, HostToolkitInventoryStore } from '../../../services/host/src/toolkits/toolkitInventory';
import { createStudioWithPets } from '../../support/livePets';
import { createInvocationContextBridge } from './invocationContextBridge';

class Model extends BaseChatModel {
  private index = 0;
  constructor(private readonly respond: (messages: BaseMessage[], index: number) => AIMessage) { super({}); }
  _llmType() { return 'channel-preparation-test'; }
  bindTools() { return this; }
  async _generate(messages: BaseMessage[]) {
    const message = this.respond(messages, this.index++);
    return { generations: [{ message, text: message.text }] };
  }
}

const call = (name: string, args: Record<string, unknown>, id: string) =>
  new AIMessage({ content: '', tool_calls: [{ name, args, id, type: 'tool_call' }] });

test('a separate Channel hint reaches planning and Channel context is read before business work', async () => {
  const root = await mkdtemp(join(tmpdir(), 'channel-hint-'));
  const goal = randomUUID(), focus = randomUUID(), original = randomUUID(), evidence = randomUUID(), final = randomUUID();
  const bridge = createInvocationContextBridge();
  const channel = createChannelPlugin({ httpRoute: false, routing: { enabled: true },
    routeDecider: async () => ({ target: 'pet:reviewer', confidence: 1, focus }),
  });
  let host: Awaited<ReturnType<typeof createResidentPetHost>> | undefined;
  let studio: Awaited<ReturnType<typeof createStudioWithPets>> | undefined;
  let observedHint: AgentInvocationHint | undefined;
  let read = false, business = false, settled = false;
  const entry = new Model(messages => {
    assert.ok(observedHint);
    assert.equal(observedHint.focus, focus);
    assert.ok(messages.some(m => m.text.includes(observedHint!.instruction)));
    return call('plan_request', { goal }, 'request');
  });
  const supervisor = new Model((messages, index) => {
    assert.ok(messages.some(m => m.text.includes(goal) && m.text.includes(observedHint!.instruction)),
      'goal and provider hint arrive together in the Supervisor frame');
    if (index === 0) return call('submit_plan', { tasks: [
      { capability: 'channel_context', objective: 'Read current conversation background.' },
      { capability: 'review', objective: 'Review the requested evidence.' },
    ] }, 'plan');
    if (index === 1) return call('delegate_capability', { briefing: 'Read the latest relevant Channel background.' }, 'read');
    if (index === 2) { assert.equal(read, true); return call('review_current', { completed: true, reason: 'Background returned.' }, 'accept-context'); }
    if (index === 3) {
      assert.ok(messages.some(m => ToolMessage.isInstance(m) && m.name === 'delegate_capability' && m.text.includes(evidence)));
      return call('delegate_capability', { briefing: 'Use the returned background to review the evidence.' }, 'review');
    }
    if (index === 4) { assert.equal(business, true); return call('review_current', { completed: true, reason: 'Review returned.' }, 'accept-review'); }
    assert.equal(index, 5);
    return new AIMessage(`[@Local](participant:human:local) ${final}`);
  });
  const child = new Model((messages, index) => {
    if (index === 0) return call('channel_read_context', {}, 'read-channel');
    if (index === 1) {
      const result = messages.find(m => ToolMessage.isInstance(m) && m.name === 'channel_read_context');
      assert.ok(result);
      const context = JSON.parse(result.text);
      assert.ok(context.messages.some((m: { body: string }) => m.body === original));
      read = true;
      return new AIMessage(evidence);
    }
    assert.equal(index, 2);
    assert.equal(read, true);
    assert.ok(messages.some(m => ToolMessage.isInstance(m) && m.name === 'delegate_capability' && m.text.includes(evidence)),
      'the next Capability receives the context delivery through canonical history');
    business = true;
    return new AIMessage('The requested evidence is aligned.');
  });
  try {
    const inventory = await buildHostToolkitInventory({ sources: [{ id: 'channel', kind: 'plugin', definitions: channel.toolkits }] });
    const config = buildHostRuntimeConfig(root), graph = new HostGraphService();
    const setupModels = (setup: AgentChannelSetup): AgentChannelSetup => {
      observedHint = setup.input.context?.hint;
      return { ...setup, graphConfig: { ...setup.graphConfig, models: { answer: entry, act: supervisor, subagent: child } } };
    };
    host = await createResidentPetHost({ petId: 'reviewer', petName: 'Reviewer', runtimeConfig: config,
      modelProfiles: createTestModelProfiles(), resolveInvocationContext: bridge.resolveInvocationContext,
      capabilities: [
        { name: 'channel_context', description: 'Read and summarize current Channel background.', uses: ['channel'], instructions: defineInstructionDocument({ content: 'Read relevant Channel messages and return their background.' }) },
        { name: 'review', description: 'Review evidence against the background.', uses: [], instructions: defineInstructionDocument({ content: 'Review the requested evidence using the available background.' }) },
      ],
      toolkitInventory: new HostToolkitInventoryStore(inventory), toolAuthorizationMode: 'full_access', autoAuthorizationSafetyLevel: 'strict',
      checkpointer: new FileSaver(config.checkpointPath), sessionStatePath: config.tuiSessionPath,
      capabilityArtifactStore: { writeArtifact: async () => { throw Error('unused'); }, readArtifact: async () => { throw Error('unused'); },
        listArtifacts: async () => [], deleteThreadArtifacts: async () => {}, getDownloadUri: async uri => uri },
      graphService: { readThreadState: (setup: AgentChannelSetup) => graph.readThreadState(setupModels(setup)),
        settleAbortedRun: (setup: AgentChannelSetup) => graph.settleAbortedRun(setupModels(setup)),
        streamEvents: (setup: AgentChannelSetup) => graph.streamEvents(setupModels(setup)) } as never,
    });
    host.resident.dispatch.onDispatchLifecycle(event => { if (event.state === 'completed') settled = true; });
    studio = await createStudioWithPets({ studioId: 'separate-hint', plugins: [channel], onPreparedContextResolver: bridge.onPreparedContextResolver,
      storage: { kind: 'sqlite', path: join(root, 'studio.sqlite') },
      pets: [{ registration: { petId: 'reviewer', name: 'Reviewer' }, dispatch: host.resident.dispatch, sessions: host.sessions }],
    });
    const me = { kind: 'human' as const, id: 'local' };
    const cid = (await channel.service.createChannel(me, { title: 'Preparation', pets: ['reviewer'] })).channel.channelId;
    await channel.sendMessage(cid, { body: original }, me);
    for (let i = 0; i < 1000 && !settled; i++) await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(settled, true);
    assert.equal(read, true); assert.equal(business, true);
    assert.equal((await channel.service.readContext(me, cid)).messages.filter(m => m.author.kind === 'pet').length, 1);
  } finally {
    await studio?.shutdown();
    await host?.close();
    await rm(root, { recursive: true, force: true });
  }
});
