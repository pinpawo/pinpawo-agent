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

class ObservingModel extends BaseChatModel {
  constructor(private readonly observe: (messages: BaseMessage[]) => void) { super({}); }
  _llmType() { return 'channel-prompt-context-test'; }
  bindTools() { return this; }
  async _generate(messages: BaseMessage[]) {
    this.observe(messages);
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
  const observed: string[] = [];
  const nonSystemMessages: string[][] = [];
  const model = new ObservingModel(messages => {
    assert.equal(messages[0]?._getType(), 'system');
    observed.push(messages[0]!.text);
    nonSystemMessages.push(messages.slice(1).map(message => message.text));
  });
  const channel = createChannelPlugin({ httpRoute: false });
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
      storage: { kind: 'sqlite', path: join(root, 'channel.sqlite') },
      pets: [{ registration: { petId: 'worker', name: 'Worker' }, dispatch: host.resident.dispatch }],
    });
    const a = (await channel.service.createChannel(me, { title: 'A', prompt: alpha, pets: ['worker'] }, { studio: true })).channel.channelId;
    const b = (await channel.service.createChannel(me, { title: 'B', prompt: beta, pets: ['worker'] }, { studio: true })).channel.channelId;
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
      for (const marker of [alpha, beta, revised]) {
        assert.equal(observed[index]!.includes(marker), marker === expected, 'only the current Channel instructions reach the model');
        assert.ok(nonSystemMessages[index]!.every(message => !message.includes(marker)), 'Channel instructions are not mixed into conversation messages');
      }
    }
  } finally {
    await host?.close(); await studio?.shutdown();
    await rm(root, { recursive: true, force: true });
  }
});
