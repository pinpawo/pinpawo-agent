import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { defineInstructionDocument, GENERAL_CAPABILITY_NAME } from '@pinpawo/pet-agent';
import { buildHostRuntimeConfig, FileSaver } from 'pinpawo/host-runtime';
import { buildStudio } from '../../../packages/studio/src/host/buildStudio';
import { resolveStudio } from '../../../packages/studio/src/host/studioConfig';
import type { HeadInput, HeadMessage } from '../../../packages/studio/src/host/petHead';
import type { StudioModelEndpoint, StudioPlugin } from '../../../packages/studio/src/studioContract';
import { createChannelPlugin } from '../../../plugins/channel/src/channelPlugin';
import { createTestModelProfiles } from '../../../services/host/src/testing/modelProfiles';
import { HostToolkitInventoryStore } from '../../../services/host/src/toolkits/toolkitInventory';

const human = { kind: 'human' as const, id: 'local' };

async function waitFor(predicate: () => boolean) {
  for (let attempt = 0; attempt < 1000; attempt++) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error('Timed out waiting for the owner Head.');
}

test('production Pet Head subscriptions receive only real messages from their owner Channel', async () => {
  const workdir = await mkdtemp(path.join(tmpdir(), 'head-topic-e2e-'));
  const channel = createChannelPlugin({ httpRoute: false });
  const decisions: Record<string, string[]> = { alpha: [], beta: [] };
  const deliveries: Record<string, string[]> = { alpha: [], beta: [] };
  const published: Array<{ topic: string | undefined; message: HeadMessage }> = [];
  const model = {
    withStructuredOutput: () => ({
      invoke: async (messages: Array<[string, string]>) => {
        const { pet, message } = JSON.parse(messages[1]![1]) as HeadInput;
        decisions[pet.petId]!.push(message.body);
        return { action: 'ignore', text: '' };
      },
    }),
  } as unknown as ReturnType<NonNullable<StudioModelEndpoint['createChatModel']>>;
  const scriptedModels: StudioPlugin = {
    name: 'scripted-head-models', toolkits: [],
    start: context => {
      // Replace only the model transport; buildStudio still owns Head assembly.
      context.models.resolve = () => ({
        profileId: 'test', baseUrl: 'https://models.example.test/v1', apiKey: 'test-key', model: 'scripted',
        createChatModel: () => model,
      });
    },
  };
  let result: Awaited<ReturnType<typeof buildStudio>> | undefined;
  try {
    result = await buildStudio({
      configuration: {
        workdir,
        studioConfigPath: path.join(workdir, '.pinpawo', 'studio.json'),
        petsDir: path.join(workdir, '.pinpawo', 'pets'),
        resolved: resolveStudio({
          studioId: 'head-topic', definitions: ['worker'], storage: { kind: 'sqlite', path: ':memory:' },
        }, [{ definitionId: 'worker', name: 'Worker' }]),
        plugins: [channel, scriptedModels],
      },
      modelProfiles: createTestModelProfiles(),
      hostCapabilities: [{
        name: GENERAL_CAPABILITY_NAME, description: 'Test baseline.', uses: [],
        instructions: defineInstructionDocument({ content: '# General' }),
      }],
      petCapabilities: new Map(),
      toolkitInventory: new HostToolkitInventoryStore(),
      checkpoint: new FileSaver(path.join(workdir, 'checkpoints.json')),
      runtimeConfig: buildHostRuntimeConfig(workdir),
      toolAuthorizationMode: 'require_authorization',
      autoAuthorizationSafetyLevel: 'strict',
    });
    const studio = result.studio;
    const subscribe = studio.subscribe;
    let subscribingPet = '';
    studio.subscribe = (handler, filter) => {
      const petId = subscribingPet;
      // Count before bindPetHeadChannel can inspect the payload or ignore it.
      // A broadcast subscription with a consumer-side Channel check fails here.
      return subscribe(event => {
        if (event.source === 'channel' && event.type === 'channel.message.created') {
          deliveries[petId]!.push((event.payload as HeadMessage).body);
        }
        return handler(event);
      }, filter);
    };
    subscribe(event => {
      if (event.source === 'channel' && event.type === 'channel.message.created') {
        published.push({ topic: event.topic, message: event.payload as HeadMessage });
      }
    });
    const owners: Record<string, string> = {};
    for (const petId of ['alpha', 'beta']) {
      const { channel: { channelId } } = await channel.service.createChannel(human, { title: petId, pets: [] });
      owners[petId] = channelId;
      subscribingPet = petId;
      await studio.pets.create({ petId, definitionId: 'worker', name: petId, channelId });
    }
    const { channel: { channelId: emptyChannelId } } = await channel.service.createChannel(human, { title: 'No Pets', pets: [] });
    await channel.service.postMessage(human, owners.alpha!, { body: 'alpha first' });
    await waitFor(() => decisions.alpha!.includes('alpha first'));
    await channel.service.postMessage(human, emptyChannelId, { body: 'no owner here' });
    await channel.service.postMessage(human, owners.beta!, { body: 'beta only' });
    await channel.service.postMessage(human, owners.alpha!, { body: 'alpha second' });
    await waitFor(() => decisions.beta!.includes('beta only') && decisions.alpha!.includes('alpha second'));

    assert.deepEqual(deliveries, { alpha: ['alpha first', 'alpha second'], beta: ['beta only'] },
      'another Channel never enters the Head subscriber wrapper, including Channels with no live Pet');
    assert.deepEqual(decisions, deliveries, 'owner messages continue through the production Head');
    assert.deepEqual(published.map(({ topic, message }) => ({ topic, channelId: message.channelId, body: message.body })), [
      { topic: owners.alpha, channelId: owners.alpha, body: 'alpha first' },
      { topic: emptyChannelId, channelId: emptyChannelId, body: 'no owner here' },
      { topic: owners.beta, channelId: owners.beta, body: 'beta only' },
      { topic: owners.alpha, channelId: owners.alpha, body: 'alpha second' },
    ], 'the real Channel producer labels committed messages and global observers receive each once');
  } finally {
    await result?.studio.shutdown();
    await rm(workdir, { recursive: true, force: true });
  }
});
