import assert from 'node:assert/strict';
import test from 'node:test';
import type { StructuredTool } from '@langchain/core/tools';

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

test('buildLocalChatAgentInput omits empty legacy direct tools', () => {
  const setup = buildLocalChatAgentInput({
    context: createContext(),
    userMessage: 'hello',
  });

  assert.equal(setup.input.tools, undefined);
});

test('buildLocalChatAgentInput keeps non-empty legacy direct tools', () => {
  const legacyTool = { name: 'legacy_tool' } as StructuredTool;
  const setup = buildLocalChatAgentInput({
    context: createContext(),
    userMessage: 'hello',
    tools: [legacyTool],
  });

  assert.deepEqual(setup.input.tools, [legacyTool]);
});

test('buildLocalScheduledAgentInput omits empty legacy direct tools', () => {
  const setup = buildLocalScheduledAgentInput({
    context: createContext(),
  });

  assert.equal(setup.input.tools, undefined);
});
