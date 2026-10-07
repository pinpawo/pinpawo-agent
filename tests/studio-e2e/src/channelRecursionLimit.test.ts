import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AIMessage, HumanMessage } from '@langchain/core/messages';
import { createChannelPlugin, type ChannelMessage } from '@pinpawo-plugin/channel';
import { createStudio } from '@pinpawo/studio';
import { buildHostRuntimeConfig, createResidentPetHost, FileSaver } from 'pinpawo/host-runtime';
import { createTestModelProfiles } from '../../../services/host/src/testing/modelProfiles';
import { HostToolkitInventoryStore } from '../../../services/host/src/toolkits/toolkitInventory';

async function waitFor(done: () => boolean) {
  for (let i = 0; i < 1000; i++) { if (done()) return; await new Promise(resolve => setTimeout(resolve, 5)); }
  throw new Error('Timed out waiting for the dispatch to end.');
}

test('a call announced to the Channel is not left running when the run ends on the recursion limit', async () => {
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
    modelProfiles: createTestModelProfiles(), globalReviewPolicyMode: 'full_access', autoAuthorizationSafetyLevel: 'strict',
    capabilities: [], toolkitInventory: new HostToolkitInventoryStore(), checkpointer, sessionStatePath: runtimeConfig.tuiSessionPath,
    capabilityArtifactStore: { writeArtifact: async () => { throw Error('unused'); }, readArtifact: async () => { throw Error('unused'); },
      listArtifacts: async () => [], deleteThreadArtifacts: async () => {}, getDownloadUri: async uri => uri },
    graphService: graphService as never,
  });
  const channel = createChannelPlugin({ databasePath: join(root, 'channel.sqlite'), httpRoute: false });
  const studio = await createStudio({ studioId: 'recursion-limit', entryPetId: 'one', plugins: [channel],
    pets: [{ registration: { petId: 'one', name: 'One' }, dispatch: host.resident.dispatch }],
  });
  try {
    const id = channel.service.createChannel({ title: 'Goal', goal: 'Inspect.', scope: 'Round' }, { kind: 'human', id: 'owner' }).channelId;
    await channel.execute(id, { petId: 'one', body: 'Inspect.' });
    const published = () => channel.service.readHistory(id).entries
      .filter((entry): entry is ChannelMessage => entry.kind === 'message' && !!entry.source);
    await waitFor(() => published().some(message => !message.toolCalls));
    assert.deepEqual(channel.service.readExecutions(id).executions.map(execution => execution.state), ['completed']);
    assert.match(published().find(message => !message.toolCalls)!.body, /步数已达上限/);
    // The run ended without the call's result: it stops being Running, and is not reported as a success.
    assert.deepEqual(published().filter(message => message.toolCalls)
      .map(message => message.toolCalls!.map(call => [call.name, call.status])), [[['plan_request', 'interrupted']]]);
  } finally { await host.close(); await studio.shutdown(); await rm(root, { recursive: true, force: true }); }
});
