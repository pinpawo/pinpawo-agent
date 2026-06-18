import assert from 'node:assert/strict';
import test from 'node:test';

import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { ToolMessage } from '@langchain/core/messages';
import { buildDecisionStructuredOutput, buildLocalChatAgentInput } from './agentChannel';
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

test('buildDecisionStructuredOutput selects structured output strategy by provider model family and version', () => {
  assert.deepEqual(buildDecisionStructuredOutput({
    apiKey: 'test-key',
    baseUrl: 'https://api.deepseek.com',
    model: 'deepseek-v4-pro',
  }), { method: 'jsonMode' });

  assert.deepEqual(buildDecisionStructuredOutput({
    apiKey: 'test-key',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    model: 'qwen3.5-plus',
  }), { method: 'jsonMode' });

  assert.deepEqual(buildDecisionStructuredOutput({
    apiKey: 'test-key',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    model: 'qwen3.7-plus',
  }), { method: 'jsonMode' });

  assert.deepEqual(buildDecisionStructuredOutput({
    apiKey: 'test-key',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    model: 'qwen3.7-max',
  }), { method: 'jsonMode' });

  assert.deepEqual(buildDecisionStructuredOutput({
    apiKey: 'test-key',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    model: 'glm-5',
  }), { method: 'jsonMode' });

  assert.deepEqual(buildDecisionStructuredOutput({
    apiKey: 'test-key',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    model: 'kimi-k2.6',
  }), { method: 'jsonSchema' });

  assert.deepEqual(buildDecisionStructuredOutput({
    apiKey: 'test-key',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    model: 'MiniMax-M2.6',
  }), { method: 'jsonMode' });

  assert.deepEqual(buildDecisionStructuredOutput({
    apiKey: 'test-key',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    model: 'stepfun/step-3.7-flash',
  }), { method: 'jsonMode' });

  assert.deepEqual(buildDecisionStructuredOutput({
    apiKey: 'test-key',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    model: 'qwen2.5-turbo',
  }), { method: 'jsonMode' });

  assert.deepEqual(buildDecisionStructuredOutput({
    apiKey: 'test-key',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    model: 'qwen-plus',
  }), { method: 'jsonMode' });

  assert.deepEqual(buildDecisionStructuredOutput({
    apiKey: 'test-key',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    model: 'glm-4.5',
  }), { method: 'jsonMode' });

  assert.deepEqual(buildDecisionStructuredOutput({
    apiKey: 'test-key',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    model: 'kimi-k2.5',
  }), { method: 'jsonMode' });

  assert.deepEqual(buildDecisionStructuredOutput({
    apiKey: 'test-key',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    model: 'MiniMax-M2.5',
  }), { method: 'jsonMode' });

  assert.deepEqual(buildDecisionStructuredOutput({
    apiKey: 'test-key',
    baseUrl: 'https://workspace-id.cn-beijing.maas.aliyuncs.com/compatible-mode/v1',
    model: 'provider-model-with-json-mode',
  }), { method: 'jsonMode' });

  assert.equal(buildDecisionStructuredOutput({
    apiKey: 'test-key',
    baseUrl: 'https://example.test/v1',
    model: 'gpt-4o',
  }), undefined);

  assert.deepEqual(buildDecisionStructuredOutput({
    apiKey: 'test-key',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    model: 'qwen3.7-max',
    structuredOutputAutoRepair: true,
    structuredOutputRepairMaxRetries: 2,
  }), {
    method: 'jsonMode',
    autoRepair: { maxRetries: 2 },
  });
});

test('buildLocalChatAgentInput uses caller-provided workdir', () => {
  const setup = buildLocalChatAgentInput({
    context: createContext(),
    userMessage: 'hello',
    workdir: '/tmp/pinpawo-chat-workdir',
  });

  assert.equal(setup.input.workdir, '/tmp/pinpawo-chat-workdir');
  assert.match(setup.input.runtimeEnvironment ?? '', /Agent 工作目录：\/tmp\/pinpawo-chat-workdir/);
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
    method: 'jsonMode',
  });
});
