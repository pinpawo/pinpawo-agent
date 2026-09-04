import assert from 'node:assert/strict';
import test from 'node:test';
import type { OrchestratorGraph } from '@pinpawo/pet-agent';
import type { AgentChannelSetup } from './agentChannel';
import {
  LocalAgentGraphService,
  buildAgentGraphConfigurable,
} from './agentGraphService';

function setup(
  interfaceContext?: AgentChannelSetup['interfaceContext'],
): AgentChannelSetup {
  return {
    graphKey: 'test',
    graphConfig: {},
    registry: { authorizationGeneration: 'test' },
    input: {
      actor: { petId: 'pet', userId: null, name: 'Pet' },
      messages: [],
      threadId: 'thread',
    },
    ...(interfaceContext ? { interfaceContext } : {}),
  } as unknown as AgentChannelSetup;
}

test('headless graph sessions keep checkpointed authorization without human review', () => {
  const configurable = buildAgentGraphConfigurable(setup());

  assert.deepEqual(configurable?.reviewCapabilities, {
    humanReview: false,
    sessionAuthorization: true,
  });
});

test('interactive graph sessions use interface-provided review capabilities', () => {
  const configurable = buildAgentGraphConfigurable(setup({
    kind: 'app_chat',
    threadId: 'thread',
    capabilities: {
      humanReview: true,
      sessionAuthorization: true,
    },
  } as unknown as AgentChannelSetup['interfaceContext']));

  assert.deepEqual(configurable?.reviewCapabilities, {
    humanReview: true,
    sessionAuthorization: true,
  });
});

test('explicit null input continues the current LangGraph task', async () => {
  const streamInputs: unknown[] = [];
  const invokeInputs: unknown[] = [];
  const graph = {
    async streamEvents(input: unknown) {
      streamInputs.push(input);
      return {};
    },
    async invoke(input: unknown) {
      invokeInputs.push(input);
      return {};
    },
  } as unknown as OrchestratorGraph;
  const service = new LocalAgentGraphService();
  const graphs = (service as unknown as {
    graphs: Map<string, OrchestratorGraph>;
  }).graphs;
  graphs.set('test', graph);

  await service.streamEvents(setup(), null);
  await service.invokeState(setup(), null);

  assert.deepEqual(streamInputs, [null]);
  assert.deepEqual(invokeInputs, [null]);
});
