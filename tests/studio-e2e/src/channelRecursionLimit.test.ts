import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AIMessage, HumanMessage } from '@langchain/core/messages';
import { createChannelPlugin } from '@pinpawo-plugin/channel';
import { createStudio } from '@pinpawo/studio';
import { buildHostRuntimeConfig, createResidentPetHost, FileSaver } from 'pinpawo/host-runtime';
import { createTestModelProfiles } from '../../../services/host/src/testing/modelProfiles';
import { HostToolkitInventoryStore } from '../../../services/host/src/toolkits/toolkitInventory';

async function waitFor(done: () => boolean | Promise<boolean>) {
  for (let i = 0; i < 1000; i++) { if (await done()) return; await new Promise(resolve => setTimeout(resolve, 5)); }
  throw new Error('Timed out waiting for the dispatch to end.');
}

test('a run ending on the recursion limit lands its notice as the Pet message, never the tool call it announced', async () => {
  const root = await mkdtemp(join(tmpdir(), 'channel-recursion-limit-'));
  const runtimeConfig = buildHostRuntimeConfig(join(root, 'one'));
  const checkpointer = new FileSaver(runtimeConfig.checkpointPath);
  // The run's stream as Host reads it: a main message announcing a call, then the hard breaker.
  const graphService = {
    async readThreadState() { return { messages: [], pendingInterrupt: null, acceptsResume: false, currentPlan: null }; },
    async *streamEvents() {
      const runId = 'run-1', pinpawo = { runId };
      const human = new HumanMessage({ id: 'human-1', content: 'Inspect.', additional_kwargs: { pinpawo } });
      const values = (messages: unknown[]) => ({ type: 'event', seq: 0, method: 'values', params: { namespace: [], data: { runId, messages } } });
      yield values([human]);
      yield values([human, new AIMessage({ id: 'ai-1', content: '', additional_kwargs: { pinpawo },
        tool_calls: [{ id: 'call-1', name: 'plan_request', args: { goal: 'Inspect.' } }] })]);
      throw Object.assign(new Error('Recursion limit of 135 reached without hitting a stop condition.'),
        { lc_error_code: 'GRAPH_RECURSION_LIMIT' });
    },
  };
  const host = await createResidentPetHost({ petId: 'one', petName: 'One', runtimeConfig,
    modelProfiles: createTestModelProfiles(), toolAuthorizationMode: 'full_access', autoAuthorizationSafetyLevel: 'strict',
    capabilities: [], toolkitInventory: new HostToolkitInventoryStore(), checkpointer, sessionStatePath: runtimeConfig.tuiSessionPath,
    capabilityArtifactStore: { writeArtifact: async () => { throw Error('unused'); }, readArtifact: async () => { throw Error('unused'); },
      listArtifacts: async () => [], deleteThreadArtifacts: async () => {}, getDownloadUri: async uri => uri },
    graphService: graphService as never,
  });
  const channel = createChannelPlugin({ httpRoute: false });
  const studio = await createStudio({ studioId: 'recursion-limit', entryPetId: 'one', plugins: [channel],
    storage: { kind: 'sqlite', path: join(root, 'channel.sqlite') },
    pets: [{ registration: { petId: 'one', name: 'One' }, dispatch: host.resident.dispatch }],
  });
  try {
    const id = (await channel.service.createChannel(channel.operator, { title: 'Goal', pets: ['one'] })).channel.channelId;
    const completed: string[] = [];
    studio.subscribe(event => { if (event.type === 'dispatch.completed') completed.push((event.payload as { invocationId: string }).invocationId); });
    const { deliveries } = await channel.sendMessage(id, { body: 'Inspect.', mentions: [{ participantId: 'pet:one' }] });
    const published = async () => (await channel.service.readContext(channel.operator, id)).messages.filter(message => message.author.kind === 'pet');
    await waitFor(async () => (await published()).length > 0 && completed.length > 0);
    assert.deepEqual(completed, [deliveries[0]!.invocationId]);
    // Only the notice is public; the announced plan_request call stays in Agent Session.
    assert.equal((await published()).length, 1);
    assert.match((await published())[0]!.body, /步数已达上限/);
    assert.deepEqual((await published())[0]!.mentions, []);
  } finally { await host.close(); await studio.shutdown(); await rm(root, { recursive: true, force: true }); }
});
