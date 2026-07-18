import assert from 'node:assert/strict';
import test from 'node:test';

import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { AIMessage } from '@langchain/core/messages';
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
  }), { method: 'jsonMode' });

  assert.deepEqual(buildDecisionStructuredOutput({
    apiKey: 'test-key',
    baseUrl: 'https://api.moonshot.ai/v1',
    model: 'kimi-k2.6',
  }), { method: 'jsonSchema' });

  assert.deepEqual(buildDecisionStructuredOutput({
    apiKey: 'test-key',
    baseUrl: 'https://api.kimi.com/coding/v1',
    model: 'k3',
  }), { method: 'jsonSchema' });

  assert.deepEqual(buildDecisionStructuredOutput({
    apiKey: 'test-key',
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-5.5',
  }), { method: 'jsonSchema' });

  assert.deepEqual(buildDecisionStructuredOutput({
    apiKey: 'test-key',
    baseUrl: 'https://example-gemini-compatible.test/v1',
    model: 'gemini-3.5-flash',
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

test('buildLocalChatAgentInput passes global review policy mode to graph input', () => {
  const setup = buildLocalChatAgentInput({
    context: createContext(),
    userMessage: 'hello',
    llmConfig: {
      apiKey: 'test-key',
      baseUrl: 'https://api.deepseek.com',
      model: 'deepseek-v4-pro',
      globalReviewPolicyMode: 'auto_authorization',
      structuredOutputAutoRepair: true,
      structuredOutputRepairMaxRetries: 2,
    },
  });

  assert.deepEqual(setup.input.globalReviewPolicy, {
    mode: 'auto_authorization',
    structuredOutput: {
      method: 'jsonMode',
      autoRepair: { maxRetries: 2 },
    },
  });
});

test('buildLocalChatAgentInput uses caller-provided workdir', () => {
  const setup = buildLocalChatAgentInput({
    context: createContext(),
    userMessage: 'hello',
    workdir: '/tmp/pinpawo-chat-workdir',
  });

  assert.equal(setup.input.workdir, '/tmp/pinpawo-chat-workdir');
  assert.match(setup.input.runtimeEnvironment ?? '', /工作目录：\/tmp\/pinpawo-chat-workdir/);
  assert.doesNotMatch(setup.input.runtimeEnvironment ?? '', /进程 cwd/);
});

test('buildLocalChatAgentInput exposes only the current-thread artifact root', () => {
  const setup = buildLocalChatAgentInput({
    context: createContext(),
    userMessage: 'hello',
    threadId: 'thread/with space',
    capabilityArtifactRoot: '/tmp/work/.pinpawo/capability-artifacts',
  });

  assert.equal(
    setup.input.artifactDiscoveryRoot,
    '/tmp/work/.pinpawo/capability-artifacts/threads/thread%2Fwith%20space',
  );
});

test('buildLocalChatAgentInput uses caller-provided stable session time', () => {
  const params = {
    context: createContext(),
    userMessage: 'hello',
    workdir: '/tmp/pinpawo-chat-workdir',
    sessionStartedAt: '2026-06-23T10:30:00+08:00',
    timezone: 'Asia/Shanghai',
  };
  const first = buildLocalChatAgentInput(params);
  const second = buildLocalChatAgentInput(params);

  assert.equal(first.input.runtimeEnvironment, second.input.runtimeEnvironment);
  assert.match(first.input.runtimeEnvironment ?? '', /会话开始时间：2026-06-23T10:30:00\+08:00/);
  assert.match(first.input.runtimeEnvironment ?? '', /时区：Asia\/Shanghai/);
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
  const result = await runtime.middleware?.afterRun?.({
    messages: [new AIMessage('final explore evidence')],
    artifacts: [],
    completionReason: 'natural',
  }, {
    capabilityId: 'explore',
    delegationId: 'dg-1',
    runId: 'run-1',
  });

  assert.match(String(result?.messages.at(-1)?.content ?? ''), /summary with viewed files/);
  assert.deepEqual(capturedOptions, {
    name: 'explore_knowledge_ingest',
    method: 'jsonMode',
  });
});
