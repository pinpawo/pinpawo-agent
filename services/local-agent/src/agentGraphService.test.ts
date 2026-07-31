import assert from 'node:assert/strict';
import test from 'node:test';
import type { AgentChannelSetup } from './agentChannel';
import { buildAgentGraphConfigurable } from './agentGraphService';

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
