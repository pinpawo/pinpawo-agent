import assert from 'node:assert/strict';
import { readChannelTestInput, type ChannelTestInput } from '../../support/channelDispatchInput';
import test from 'node:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AIMessage, ToolMessage, type BaseMessage } from '@langchain/core/messages';
import { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { createChannelPlugin } from '@pinpawo-plugin/channel';
import { createStudio } from '@pinpawo/studio';
import { buildHostRuntimeConfig, createResidentPetHost, FileSaver, loadCapabilityDirectory, loadPetDocumentFile } from 'pinpawo/host-runtime';
import { createTestModelProfiles } from '../../../services/host/src/testing/modelProfiles';
import { buildHostToolkitInventory, HostToolkitInventoryStore } from '../../../services/host/src/toolkits/toolkitInventory';
import { HostGraphService } from '../../../services/host/src/agent/agentGraphService';
import type { AgentChannelSetup } from '../../../services/host/src/agent/agentChannel';

/** The local Host token's Studio client, as a Channel member. */
const me = { kind: 'human' as const, id: 'local' };

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

async function waitFor(done: () => boolean | Promise<boolean>) {
  for (let i = 0; i < 1000; i++) { if (await done()) return; await new Promise(resolve => setTimeout(resolve, 5)); }
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
  const petMarkers = new Map(['acceptance-a', 'acceptance-b'].map(id => [id, randomUUID()]));
  const capabilityMarker = randomUUID();
  const seenContexts: Array<{ petId: string; stage: string }> = [];
  const entryInputs: Array<{ petId: string; input: ChannelTestInput }> = [];
  const observeContext = (messages: BaseMessage[], petId: string, stage: string) => {
    const system = messages[0]!;
    assert.equal(system._getType(), 'system');
    assert.equal(system.text.split(petMarkers.get(petId)!).length - 1, 1, 'Host-authored PET.md reaches each model once');
    for (const [other, marker] of petMarkers) if (other !== petId) assert.ok(!system.text.includes(marker), 'Pet documents stay isolated');
    assert.equal(system.text.split(capabilityMarker).length - 1, stage === 'capability' ? 1 : 0,
      'Capability instructions remain execution-local; root gets its domain rules from PET.md');
    seenContexts.push({ petId, stage });
  };
  let arrivedAtFinal = false, release!: () => void, betaCalls = 0;
  const holdFinal = new Promise<void>(resolve => { release = resolve; });
  const hosts: Awaited<ReturnType<typeof createResidentPetHost>>[] = [];
  const channel = createChannelPlugin({ httpRoute: false });
  let studio: Awaited<ReturnType<typeof createStudio>> | undefined;
  try {
    const capabilitiesRoot = join(root, 'capabilities');
    await mkdir(join(capabilitiesRoot, 'studio-execution'), { recursive: true });
    const capabilitySource = await readFile(new URL('../../../packages/studio/templates/default/pets/executor/capabilities/studio-execution/CAPABILITY.md', import.meta.url), 'utf8');
    // Only the Channel Toolkit is wired here; keep the shipped instructions but narrow `uses` to it.
    const channelOnlySource = capabilitySource.replace(/^uses:\n(?:  - .+\n)+/m, 'uses:\n  - channel\n');
    await writeFile(join(capabilitiesRoot, 'studio-execution', 'CAPABILITY.md'), `${channelOnlySource}\n${capabilityMarker}\n`);
    const capabilities = (await loadCapabilityDirectory(capabilitiesRoot)).map(loaded => loaded.capability);
    const inventory = await buildHostToolkitInventory({ sources: [
      { id: 'channel', kind: 'plugin', definitions: channel.toolkits },
    ] });
    for (const petId of ['acceptance-a', 'acceptance-b']) {
      const runtimeConfig = buildHostRuntimeConfig(join(root, petId));
      const checkpointer = new FileSaver(runtimeConfig.checkpointPath);
      const template = petId === 'acceptance-a' ? 'executor' : 'reviewer';
      const petSource = await readFile(new URL(`../../../packages/studio/templates/default/pets/${template}/PET.md`, import.meta.url), 'utf8');
      await mkdir(runtimeConfig.workdir, { recursive: true });
      const petPath = join(runtimeConfig.workdir, 'PET.md');
      await writeFile(petPath, `${petSource}\n${petMarkers.get(petId)}\n`);
      const petDocument = await loadPetDocumentFile(petPath);
      assert.ok(petDocument);
      const entry = new ScriptedModel((messages, index) => {
        observeContext(messages, petId, 'entry');
        const current = [...messages].reverse().find(message => message._getType() === 'human')!;
        entryInputs.push({ petId, input: readChannelTestInput(current.text) });
        if (petId === 'acceptance-b') { betaCalls++; return new AIMessage('Independent review complete.'); }
        // A later direct Entry reply must also use the public protocol, without rerunning a Capability.
        return index < replies.length ? call('plan_request', { goal: 'Publish the plan.' }, `entry-${index}`) : new AIMessage(handoff);
      });
      const supervisor = new ScriptedModel(async (messages, index) => {
        observeContext(messages, petId, 'supervisor');
        const run = Math.floor(index / 4), turn = index % 4;
        if (turn === 0) return call('submit_plan', { tasks: [{ capability: 'studio_execution', objective: 'Produce a plan.' }] }, `plan-${run}`);
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
      const subagent = new ScriptedModel(messages => {
        observeContext(messages, petId, 'capability');
        return new AIMessage(privateDelivery);
      });
      // Replace only the paid models; keep the production Host context / registry / stream path.
      const service = new HostGraphService();
      const modelSetup = (setup: AgentChannelSetup): AgentChannelSetup => ({ ...setup,
        graphConfig: { ...setup.graphConfig, models: { act: supervisor, answer: entry, subagent } },
      });
      hosts.push(await createResidentPetHost({ petId, petName: petId === 'acceptance-a' ? 'A' : 'B · Reviewer', runtimeConfig,
        modelProfiles: createTestModelProfiles(), toolAuthorizationMode: 'full_access', autoAuthorizationSafetyLevel: 'strict',
        capabilities, petDocument, toolkitInventory: new HostToolkitInventoryStore(inventory), checkpointer, sessionStatePath: runtimeConfig.tuiSessionPath,
        capabilityArtifactStore: { writeArtifact: async () => { throw Error('unused'); }, readArtifact: async () => { throw Error('unused'); },
          listArtifacts: async () => [], deleteThreadArtifacts: async () => {}, getDownloadUri: async uri => uri },
        graphService: {
          readThreadState: (setup: AgentChannelSetup) => service.readThreadState(modelSetup(setup)),
          streamEvents: (setup: AgentChannelSetup) => service.streamEvents(modelSetup(setup)),
        } as never,
      }));
    }
    studio = await createStudio({ studioId: 'final-reply', entryPetId: 'acceptance-a', plugins: [channel],
      storage: { kind: 'sqlite', path: join(root, 'channel.sqlite') },
      pets: hosts.map((host, index) => ({ registration: { petId: ['acceptance-a', 'acceptance-b'][index]!, name: index ? 'B · Reviewer' : 'A' },
        dispatch: host.resident.dispatch })),
    });
    const id = (await channel.service.createChannel(me, { title: 'Plan', pets: ['acceptance-a', 'acceptance-b'] })).channel.channelId;
    const outputs = async () => (await channel.service.readContext(me, id, { limit: 200 })).messages.filter(message => message.author.kind === 'pet');
    const alphaOutputs = async () => (await outputs()).filter(message => message.author.id === 'acceptance-a');
    const send = (body: string) => channel.sendMessage(id, { body, mentions: [{ participantId: 'pet:acceptance-a' }] }, me);
    await send('Produce the plan and selected handoff.');
    await waitFor(() => arrivedAtFinal);
    assert.deepEqual(boundaryDeliveries, [privateDelivery]);
    // Tool-call messages (plan_request, delegate_capability) are the run's process: they stay in Agent Session.
    assert.equal((await outputs()).length, 0, 'internal delivery, Supervisor work and tool calls are not published');
    assert.equal(betaCalls, 0, 'internal @ is not a dispatch');
    release();
    await waitFor(async () => (await outputs()).length === 2 && betaCalls === 1);
    assert.equal((await alphaOutputs())[0]!.body, handoff);
    assert.deepEqual((await alphaOutputs())[0]!.mentions.map(mention => mention.participantId), ['pet:acceptance-b']);
    for (let index = 1; index < replies.length; index++) {
      await send(`Produce plan variant ${index}.`);
      await waitFor(async () => (await alphaOutputs()).length === index + 1);
      assert.equal((await alphaOutputs())[index]!.body, replies[index]);
      assert.deepEqual((await alphaOutputs())[index]!.mentions, [], 'code, quotes and unselected internal links remain inert');
      assert.equal(betaCalls, 1, 'the system never adds a handoff from the internal delivery');
    }
    await send('Now publish the chosen handoff directly.');
    await waitFor(async () => (await outputs()).length === 7 && betaCalls === 2);
    assert.equal(boundaryDeliveries.length, 4, 'direct Entry reply does not repeat execution');
    assert.equal((await alphaOutputs()).at(-1)!.body, handoff);
    assert.ok((await alphaOutputs()).every(message => message.externalRef), 'each reply is keyed by its Agent Session message');
    assert.equal(new Set((await alphaOutputs()).map(message => message.externalRef)).size, (await alphaOutputs()).length);
    assert.deepEqual((await channel.service.listSessions(me, id)).map(binding => [binding.petId, binding.registered]),
      [['acceptance-a', true], ['acceptance-b', true]]);
    assert.ok((await outputs()).every(message => !message.body.includes('Internal analysis only.')));
    assert.deepEqual(['entry', 'supervisor', 'capability'].map(stage => seenContexts.filter(context => context.petId === 'acceptance-a' && context.stage === stage).length), [5, 16, 4]);
    assert.equal(seenContexts.filter(context => context.petId === 'acceptance-b' && context.stage === 'entry').length, 2);
    for (const { petId, input } of entryInputs) {
      assert.equal(input.channelId, id);
      const stored = (await channel.service.getMessage(id, input.messageId))!;
      assert.equal(input.body, stored.body);
      assert.deepEqual(input.author, petId === 'acceptance-a'
        ? { participantId: 'human:local', kind: 'human', label: 'local' }
        : { participantId: 'pet:acceptance-a', kind: 'pet', label: 'A' });
    }
  } finally {
    release(); await Promise.all(hosts.map(host => host.close())); await studio?.shutdown();
    await rm(root, { recursive: true, force: true });
  }
});
