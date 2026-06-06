import assert from 'node:assert/strict';
import test from 'node:test';

import { buildLocalChatAgentInput, buildLocalScheduledAgentInput } from './agentChannel';
import type { AgentContext } from './contextLoader';

function createContext(): AgentContext {
  return {
    pet: {
      id: 'pet-a',
      name: 'Pet A',
      personality: 'calm',
      species: 'sheep',
      stage: 'sprout',
      growth_value: 5,
      stage_asset_id: null,
    },
    context: {
      petMemoryText: 'memory',
      recentChatTurns: [],
      recentDaily: [],
      trendItems: [],
      today: '2026-06-02',
    },
  };
}

test('buildLocalChatAgentInput omits empty toolkit configurable arrays', () => {
  const setup = buildLocalChatAgentInput({
    context: createContext(),
    userMessage: 'hello',
  });

  assert.ok(setup.input.toolkits);
});

test('buildLocalScheduledAgentInput omits empty toolkit configurable arrays', () => {
  const setup = buildLocalScheduledAgentInput({
    context: createContext(),
  });

  assert.ok(setup.input.toolkits);
});
