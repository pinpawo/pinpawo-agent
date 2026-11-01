import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AIMessage, type BaseMessage } from '@langchain/core/messages';
import { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { createChannelPlugin } from '@pinpawo-plugin/channel';
import { buildHostRuntimeConfig, createResidentPetHost, FileSaver, loadPetDocumentFile } from 'pinpawo/host-runtime';
import { createTestModelProfiles } from '../../../services/host/src/testing/modelProfiles';
import { buildHostToolkitInventory, HostToolkitInventoryStore } from '../../../services/host/src/toolkits/toolkitInventory';
import { HostGraphService } from '../../../services/host/src/agent/agentGraphService';
import type { AgentChannelSetup } from '../../../services/host/src/agent/agentChannel';
import { createStudioWithPets } from '../../../tests/support/livePets';
import { createInvocationContextBridge } from './invocationContextBridge';

class ObservingModel extends BaseChatModel {
  constructor(private readonly observe: (messages: BaseMessage[]) => void | Promise<void>) { super({}); }
  _llmType() { return 'channel-prompt-context-test'; }
  bindTools() { return this; }
  async _generate(messages: BaseMessage[]) {
    await this.observe(messages);
    return { generations: [{ message: new AIMessage('Done.'), text: 'Done.' }] };
  }
}

async function waitFor(done: () => Promise<boolean>) {
  for (let i = 0; i < 1000; i++) { if (await done()) return; await new Promise(resolve => setTimeout(resolve, 5)); }
  throw new Error('Timed out waiting for the Channel response.');
}

test('Channel instructions reach the actual Pet model per invocation without replacing PET.md or leaking between Channels', async () => {
  const root = await mkdtemp(join(tmpdir(), 'channel-prompt-context-'));
  const me = { kind: 'human' as const, id: 'local' };
  const petMarker = randomUUID(), alpha = randomUUID(), beta = randomUUID(), revised = randomUUID();
  const titleA = randomUUID(), descriptionA = randomUUID(), titleB = randomUUID();
  const observed: string[] = [];
  const nonSystemMessages: string[][] = [];
  let holdNext = false;
  let modelStarted: (() => void) | undefined;
  let releaseModel: (() => void) | undefined;
  const model = new ObservingModel(async messages => {
    assert.equal(messages[0]?._getType(), 'system');
    observed.push(messages[0]!.text);
    nonSystemMessages.push(messages.slice(1).map(message => message.text));
    if (holdNext) {
      holdNext = false;
      await new Promise<void>(resolve => { releaseModel = resolve; modelStarted?.(); });
    }
  });
  const channel = createChannelPlugin({ httpRoute: false });
  const contextBridge = createInvocationContextBridge();
  let host: Awaited<ReturnType<typeof createResidentPetHost>> | undefined;
  let studio: Awaited<ReturnType<typeof createStudioWithPets>> | undefined;
  try {
    const config = buildHostRuntimeConfig(root);
    await mkdir(config.workdir, { recursive: true });
    const petPath = join(config.workdir, 'PET.md');
    await writeFile(petPath, `# Worker

Pet identity marker: ${petMarker}
`);
    const petDocument = await loadPetDocumentFile(petPath);
    assert.ok(petDocument);
    const inventory = await buildHostToolkitInventory({ sources: [] });
    const graph = new HostGraphService();
    const modelSetup = (setup: AgentChannelSetup): AgentChannelSetup => ({ ...setup,
      graphConfig: { ...setup.graphConfig, models: { act: model, answer: model, subagent: model } },
    });
    host = await createResidentPetHost({ petId: 'worker', petName: 'Worker', runtimeConfig: config,
      resolveInvocationContext: contextBridge.resolveInvocationContext,
      modelProfiles: createTestModelProfiles(), toolAuthorizationMode: 'full_access', autoAuthorizationSafetyLevel: 'strict',
      capabilities: [], petDocument, toolkitInventory: new HostToolkitInventoryStore(inventory),
      checkpointer: new FileSaver(config.checkpointPath), sessionStatePath: config.tuiSessionPath,
      capabilityArtifactStore: { writeArtifact: async () => { throw Error('unused'); }, readArtifact: async () => { throw Error('unused'); },
        listArtifacts: async () => [], deleteThreadArtifacts: async () => {}, getDownloadUri: async uri => uri },
      graphService: {
        readThreadState: (setup: AgentChannelSetup) => graph.readThreadState(modelSetup(setup)),
        streamEvents: (setup: AgentChannelSetup) => graph.streamEvents(modelSetup(setup)),
      } as never,
    });
    studio = await createStudioWithPets({ studioId: 'prompt-e2e', plugins: [channel],
      onPreparedContextResolver: contextBridge.onPreparedContextResolver,
      storage: { kind: 'sqlite', path: join(root, 'channel.sqlite') },
      pets: [{ registration: { petId: 'worker', name: 'Worker' }, dispatch: host.resident.dispatch }],
    });
    const a = (await channel.service.createChannel(me, { title: titleA, description: descriptionA, prompt: alpha, pets: ['worker'] }, { studio: true })).channel.channelId;
    const b = (await channel.service.createChannel(me, { title: titleB, prompt: beta, pets: ['worker'] }, { studio: true })).channel.channelId;
    const sendAndWait = async (id: string, expectedCount: number) => {
      await channel.sendMessage(id, { body: 'Please respond.', mentions: [{ participantId: 'pet:worker' }] }, me);
      await waitFor(async () => (await channel.service.readContext(me, id, { limit: 100 })).messages.filter(m => m.author.kind === 'pet').length === expectedCount);
    };
    await sendAndWait(a, 1);
    await sendAndWait(b, 1);
    await sendAndWait(a, 2);
    await channel.service.updateChannel(me, a, { prompt: revised }, { studio: true });
    await sendAndWait(a, 3);
    assert.equal(observed.length, 4);
    assert.equal(observed[0], observed[2], 'the same Pet and Channel session has a stable system prompt across turns');
    assert.notEqual(observed[2], observed[3], 'updating the Channel instructions changes the system prompt');
    for (const [index, expected] of [alpha, beta, alpha, revised].entries()) {
      assert.ok(observed[index]!.includes(petMarker), 'the Pet identity remains in every model call');
      assert.equal(observed[index]!.includes(titleA), index !== 1);
      assert.equal(observed[index]!.includes(descriptionA), index !== 1);
      assert.equal(observed[index]!.includes(titleB), index === 1);
      for (const marker of [alpha, beta, revised]) {
        assert.equal(observed[index]!.includes(marker), marker === expected, 'only the current Channel instructions reach the model');
        assert.ok(nonSystemMessages[index]!.every(message => !message.includes(marker)), 'Channel instructions are not mixed into conversation messages');
      }
    }

    // A queued run keeps the prompt snapshot from admission, even if another
    // Channel's prompt changes before this same Pet gets to execute it.
    const queuedRevision = randomUUID();
    const holding = new Promise<void>(resolve => { modelStarted = resolve; });
    holdNext = true;
    const held = channel.sendMessage(a, { body: 'Hold this run.', mentions: [{ participantId: 'pet:worker' }] }, me);
    await holding;
    await channel.sendMessage(b, { body: 'Run after the held task.', mentions: [{ participantId: 'pet:worker' }] }, me);
    await channel.service.updateChannel(me, b, { prompt: queuedRevision }, { studio: true });
    releaseModel!();
    await held;
    await waitFor(async () => (await channel.service.readContext(me, b, { limit: 100 })).messages.filter(m => m.author.kind === 'pet').length === 2);
    assert.equal(observed.length, 6);
    assert.ok(observed[4]!.includes(revised));
    assert.ok(observed[5]!.includes(beta));
    assert.ok(!observed[5]!.includes(queuedRevision));
    await sendAndWait(b, 3);
    assert.ok(observed[6]!.includes(queuedRevision));
    await channel.service.updateChannel(me, a, { prompt: null }, { studio: true });
    await sendAndWait(a, 5);
    assert.ok(observed[7]!.includes(titleA), 'Channel metadata remains available without an announcement');
    assert.ok(!observed[7]!.includes(revised));
    assert.ok(nonSystemMessages.every(messages => messages.every(message =>
      !message.includes(titleA) && !message.includes(descriptionA) && !message.includes(titleB))),
    'shared Channel context is not appended to conversation history');
  } finally {
    releaseModel?.();
    await host?.close(); await studio?.shutdown();
    await rm(root, { recursive: true, force: true });
  }
});
