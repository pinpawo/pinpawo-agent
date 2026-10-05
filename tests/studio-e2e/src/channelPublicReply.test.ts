import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AIMessage, ToolMessage, type BaseMessage } from '@langchain/core/messages';
import { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { buildOrchestratorRunInput, compileAgentRegistry, createOrchestratorGraph,
  defineInstructionDocument, readPendingInterrupt } from '@pinpawo/pet-agent';
import { createChannelPlugin, type ChannelMessage } from '@pinpawo-plugin/channel';
import { createStudio } from '@pinpawo/studio';
import { buildHostRuntimeConfig, createResidentPetHost, FileSaver } from 'pinpawo/host-runtime';
import { createTestModelProfiles } from '../../../services/host/src/testing/modelProfiles';
import { HostToolkitInventoryStore } from '../../../services/host/src/toolkits/toolkitInventory';
import type { AgentChannelSetup } from '../../../services/host/src/agent/agentChannel';

class ScriptedModel extends BaseChatModel {
  private calls = 0;
  constructor(private readonly respond: (messages: BaseMessage[], index: number) => AIMessage | Promise<AIMessage>) { super({}); }
  _llmType() { return 'channel-public-reply-test'; }
  bindTools() { return this; }
  async _generate(messages: BaseMessage[]) {
    const message = await this.respond(messages, this.calls++);
    return { generations: [{ message, text: message.text }] };
  }
}

const call = (name: string, args: Record<string, unknown>, id: string) =>
  new AIMessage({ content: '', tool_calls: [{ name, args, id, type: 'tool_call' }] });

async function waitFor(done: () => boolean) {
  for (let i = 0; i < 1000; i++) { if (done()) return; await new Promise(resolve => setTimeout(resolve, 5)); }
  throw new Error('Timed out waiting for final public reply.');
}

// This deterministic integration locks the publication boundary and routing semantics.
// Compliance with the final-reply prompt itself requires the separate real-model acceptance.
test('capability handoff reaches Channel only through the selected final root reply', async () => {
  const root = await mkdtemp(join(tmpdir(), 'channel-public-reply-'));
  const link = '[@B · Reviewer](participant:pet:acceptance-b)';
  const handoff = `${link} Please independently review the public plan.`;
  const privateDelivery = `Internal analysis only.\n\n${handoff}`;
  const replies = [handoff, `Address example: \`${link}\``, `> ${handoff}`, 'Public plan; no handoff selected.'];
  const boundaryDeliveries: string[] = [];
  let arrivedAtFinal = false, release!: () => void, betaCalls = 0;
  const holdFinal = new Promise<void>(resolve => { release = resolve; });
  const registry = compileAgentRegistry({ toolkits: [], capabilities: [{
    name: 'studio_planning', description: 'Plan and report.', uses: [],
    instructions: defineInstructionDocument({ content: 'Return the plan and any chosen handoff.' }),
  }] });
  const hosts: Awaited<ReturnType<typeof createResidentPetHost>>[] = [];
  const channel = createChannelPlugin({ databasePath: join(root, 'channel.sqlite'), httpRoute: false });
  let studio: Awaited<ReturnType<typeof createStudio>> | undefined;
  try {
    for (const petId of ['acceptance-a', 'acceptance-b']) {
      const runtimeConfig = buildHostRuntimeConfig(join(root, petId));
      const checkpointer = new FileSaver(runtimeConfig.checkpointPath);
      const entry = new ScriptedModel((_messages, index) => {
        if (petId === 'acceptance-b') { betaCalls++; return new AIMessage('Independent review complete.'); }
        // A later direct Entry reply must also use the public protocol, without rerunning a Capability.
        return index < replies.length ? call('plan_request', { goal: 'Publish the plan.' }, `entry-${index}`) : new AIMessage(handoff);
      });
      const supervisor = new ScriptedModel(async (messages, index) => {
        const run = Math.floor(index / 4), turn = index % 4;
        if (turn === 0) return call('submit_plan', { tasks: [{ capability: 'studio_planning', objective: 'Produce a plan.' }] }, `plan-${run}`);
        if (turn === 1) return call('delegate_capability', { briefing: 'Produce a plan with the chosen handoff.' }, `delegate-${run}`);
        const result = [...messages].reverse().find(message => ToolMessage.isInstance(message) && message.name === 'delegate_capability');
        assert.ok(result, 'the final responder receives the real Capability delivery');
        assert.equal(JSON.parse(result.text).delivery.text, privateDelivery);
        if (turn === 2) {
          boundaryDeliveries.push(JSON.parse(result.text).delivery.text);
          return call('review_current', { completed: true, reason: 'Plan produced.' }, `review-${run}`);
        }
        if (run === 0) { arrivedAtFinal = true; await holdFinal; }
        assert.ok(replies[run], 'unexpected extra Supervisor run');
        return new AIMessage(replies[run]!);
      });
      const graph = createOrchestratorGraph({ models: { act: supervisor, answer: entry,
        subagent: new ScriptedModel(() => new AIMessage(privateDelivery)) }, checkpoint: checkpointer });
      const config = (setup: AgentChannelSetup) => ({ configurable: { thread_id: setup.input.threadId, registry,
        reviewCapabilities: { humanReview: false, sessionAuthorization: false } } });
      hosts.push(await createResidentPetHost({ petId, petName: petId === 'acceptance-a' ? 'A' : 'B · Reviewer', runtimeConfig,
        modelProfiles: createTestModelProfiles(), globalReviewPolicyMode: 'full_access', autoAuthorizationSafetyLevel: 'strict',
        capabilities: [], toolkitInventory: new HostToolkitInventoryStore(), checkpointer, sessionStatePath: runtimeConfig.tuiSessionPath,
        capabilityArtifactStore: { writeArtifact: async () => { throw Error('unused'); }, readArtifact: async () => { throw Error('unused'); },
          listArtifacts: async () => [], deleteThreadArtifacts: async () => {}, getDownloadUri: async uri => uri },
        graphService: {
          async readThreadState(setup: AgentChannelSetup) {
            const snapshot = await graph.getState(config(setup));
            return { messages: snapshot.values.messages ?? [], pendingInterrupt: readPendingInterrupt(snapshot),
              acceptsResume: snapshot.next.length > 0, currentPlan: null };
          },
          streamEvents(setup: AgentChannelSetup) {
            return graph.streamEvents(buildOrchestratorRunInput(setup.input.messages), { ...config(setup), version: 'v3' });
          },
        } as never,
      }));
    }
    studio = await createStudio({ studioId: 'final-reply', entryPetId: 'acceptance-a', plugins: [channel],
      pets: hosts.map((host, index) => ({ registration: { petId: ['acceptance-a', 'acceptance-b'][index]!, name: index ? 'B · Reviewer' : 'A' },
        dispatch: host.resident.dispatch })),
    });
    const id = channel.service.createChannel({ title: 'Plan', goal: 'Plan and review.', scope: 'Round' }, { kind: 'human', id: 'studio-operator' }).channelId;
    const outputs = () => channel.service.readHistory(id).entries
      .filter((entry): entry is ChannelMessage => entry.kind === 'message' && Boolean(entry.source));
    const alphaOutputs = () => outputs().filter(message => message.author.id === 'acceptance-a');
    const send = (body: string) => channel.sendMessage(id, { body, mentions: [{ participantId: 'pet:acceptance-a' }] });
    await send('Produce the plan and selected handoff.');
    await waitFor(() => arrivedAtFinal);
    assert.deepEqual(boundaryDeliveries, [privateDelivery]);
    assert.equal(outputs().length, 0, 'internal delivery and Supervisor work are not published');
    assert.equal(betaCalls, 0, 'internal @ is not a dispatch');
    release();
    await waitFor(() => outputs().length === 2 && betaCalls === 1);
    assert.equal(alphaOutputs()[0]!.body, handoff);
    assert.deepEqual(alphaOutputs()[0]!.mentions.map(mention => mention.participantId), ['pet:acceptance-b']);
    for (let index = 1; index < replies.length; index++) {
      await send(`Produce plan variant ${index}.`);
      await waitFor(() => alphaOutputs().length === index + 1);
      assert.equal(alphaOutputs()[index]!.body, replies[index]);
      assert.deepEqual(alphaOutputs()[index]!.mentions, [], 'code, quotes and unselected internal links remain inert');
      assert.equal(betaCalls, 1, 'the system never adds a handoff from the internal delivery');
    }
    await send('Now publish the chosen handoff directly.');
    await waitFor(() => outputs().length === 7 && betaCalls === 2);
    assert.equal(boundaryDeliveries.length, 4, 'direct Entry reply does not repeat execution');
    assert.equal(alphaOutputs().at(-1)!.body, handoff);
    assert.equal(new Set(alphaOutputs().map(message => message.source!.sessionId)).size, 1);
    assert.ok(outputs().every(message => !message.body.includes('Internal analysis only.')));
  } finally {
    release(); await Promise.all(hosts.map(host => host.close())); await studio?.shutdown();
    await rm(root, { recursive: true, force: true });
  }
});
