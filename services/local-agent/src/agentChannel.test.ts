import assert from 'node:assert/strict';
import test from 'node:test';

import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { ToolMessage } from '@langchain/core/messages';
import { buildLocalChatAgentInput, buildLocalScheduledAgentInput } from './agentChannel';
import type { AgentContext } from './contextLoader';
import type { AgentCapability, AgentToolkit } from '@pinpawo/pet-agent';

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

test('buildLocalChatAgentInput passes a single toolkit list', () => {
  const generalToolkit = { name: 'general-toolkit' } as AgentToolkit;
  const setup = buildLocalChatAgentInput({
    context: createContext(),
    userMessage: 'hello',
    toolkits: [generalToolkit],
  });

  assert.deepEqual(
    setup.input.toolkits?.map((item) => item.name),
    ['pet_profile', 'general-toolkit'],
  );
  assert.equal('capabilityToolkits' in setup.input, false);
});

test('buildLocalChatAgentInput dedupes built-in capabilities by name', () => {
  const extraExplore: AgentCapability = {
    name: 'explore',
    description: 'extra explore capability',
    createRuntime: () => ({}),
  };

  const setup = buildLocalChatAgentInput({
    context: createContext(),
    userMessage: 'hello',
    extraCapabilities: [extraExplore],
  });

  const capabilities = setup.input.capabilities ?? [];
  assert.equal(
    capabilities.filter((item) => item.name === 'explore').length,
    1,
  );
});

test('buildLocalChatAgentInput passes model structured output strategy to explore', async () => {
  const setup = buildLocalChatAgentInput({
    context: createContext(),
    userMessage: 'hello',
    llmConfig: {
      apiKey: 'test-key',
      baseUrl: 'https://api.deepseek.com',
      model: 'deepseek-v4-pro',
    },
  });
  const explore = setup.input.capabilities?.find((capability) => capability.name === 'explore');
  assert.ok(explore);

  let capturedOptions: unknown;
  const model = {
    withStructuredOutput: (_schema: unknown, options: unknown) => {
      capturedOptions = options;
      return {
        invoke: async () => ({ summary: 'summary with viewed files' }),
      };
    },
  } as unknown as BaseChatModel;
  const runtime = await explore.createRuntime({
    models: { act: model },
    actor: {} as never,
    messages: [],
    availableToolkits: [],
  });
  const rewritten = await runtime.contextPolicy?.rewriteAsync?.([
    new ToolMessage({
      content: `old raw output\n${'x'.repeat(1200)}`,
      tool_call_id: 'call-1',
      name: 'view_file_chunk',
    }),
    new ToolMessage({
      content: `old raw output\n${'y'.repeat(1200)}`,
      tool_call_id: 'call-2',
      name: 'view_file_chunk',
    }),
    new ToolMessage({
      content: `old raw output\n${'z'.repeat(1200)}`,
      tool_call_id: 'call-3',
      name: 'view_file_chunk',
    }),
  ], {
    estimateMessagesTokens: () => 30_000,
    iterationCount: 2,
    operations: {},
    contextWindowTokens: 32_000,
  });

  assert.match(String(rewritten?.[0]?.content ?? ''), /summary with viewed files/);
  assert.deepEqual(capturedOptions, {
    name: 'explore_knowledge_ingest',
    method: 'functionCalling',
  });
});

test('buildLocalScheduledAgentInput omits empty toolkit configurable arrays', () => {
  const setup = buildLocalScheduledAgentInput({
    context: createContext(),
  });

  assert.ok(setup.input.toolkits);
});

test('buildLocalScheduledAgentInput passes a single toolkit list', () => {
  const setup = buildLocalScheduledAgentInput({
    context: createContext(),
    toolkits: [{ name: 'general-toolkit' }] as AgentToolkit[],
  });

  assert.deepEqual(
    setup.input.toolkits?.map((item) => item.name),
    ['pet_profile', 'general-toolkit'],
  );
  assert.equal('capabilityToolkits' in setup.input, false);
});
