import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import { buildDecisionStructuredOutput, buildLocalChatAgentInput } from './agentChannel';
import type { AgentContext } from './contextLoader';
import {
  defineInstructionDocument,
  type AgentCapability,
  type AgentToolkit,
  type CapabilityArtifactStore,
} from '@pinpawo/pet-agent';
import { FileCapabilityArtifactStore } from './capabilityArtifactStore';
import { loadGeneralCapability } from './capabilities/general';
import { createBashToolkit, createGitToolkit } from './toolkits/local';
import { createTestModelProfileRegistry } from './testing/modelProfiles';

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
      today: '2026-06-02',
    },
  };
}

function createGeneralToolkit(): AgentToolkit {
  return {
    name: 'general-toolkit',
    description: 'general toolkit',
    tools: [{
      tool: tool(async () => 'ok', {
        name: 'general_tool',
        description: 'general tool',
        schema: z.object({}),
      }),
    }],
  };
}

const testArtifactStore: CapabilityArtifactStore = {
  writeArtifact: async () => {
    throw new Error('test artifact writes require an explicit store');
  },
  readArtifact: async () => {
    throw new Error('test artifact reads require an explicit store');
  },
  listArtifacts: async () => [],
  deleteThreadArtifacts: async () => undefined,
  getDownloadUri: async (uri) => uri,
};

type LocalChatAgentInputParams = Parameters<typeof buildLocalChatAgentInput>[0];

function buildTestLocalChatAgentInput(
  params: Omit<LocalChatAgentInputParams, 'threadId' | 'capabilityArtifactStore'>
    & Partial<Pick<LocalChatAgentInputParams, 'threadId' | 'capabilityArtifactStore'>>,
) {
  const { extraCapabilities, ...rest } = params;
  const general = loadGeneralCapability();
  return buildLocalChatAgentInput({
    threadId: 'agent-channel-test-thread',
    capabilityArtifactStore: testArtifactStore,
    ...rest,
    extraCapabilities: [
      ...(general ? [general] : []),
      ...(extraCapabilities ?? []),
    ],
  });
}

test('buildLocalChatAgentInput omits empty toolkit configurable arrays', () => {
  const setup = buildTestLocalChatAgentInput({
    context: createContext(),
    userMessage: 'hello',
  });

  assert.ok(setup.input.toolkits);
});

test('buildLocalChatAgentInput passes the generation reserve to main and subagent contexts', () => {
  const setup = buildTestLocalChatAgentInput({
    context: createContext(),
    userMessage: 'hello',
    llmConfig: {
      apiKey: 'test-key',
      baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
      model: 'qwen3.8-max',
      contextWindowTokens: 983_616,
      maxOutputTokens: 131_072,
    },
  });

  assert.equal(setup.graphConfig.generationReserveTokens, 147_456);
  assert.equal(setup.graphConfig.subagentGenerationReserveTokens, 147_456);
});

test('buildLocalChatAgentInput keeps the Capability registry backend explicit', () => {
  const filesystem = buildTestLocalChatAgentInput({
    context: createContext(),
    userMessage: 'hello',
    capabilityRegistryBackend: 'filesystem',
  });
  const memory = buildTestLocalChatAgentInput({
    context: createContext(),
    userMessage: 'hello',
    capabilityRegistryBackend: 'memory',
  });

  assert.equal(filesystem.graphConfig.capabilityRegistryBackend, 'filesystem');
  assert.equal(memory.graphConfig.capabilityRegistryBackend, 'memory');
  assert.notEqual(filesystem.graphKey, memory.graphKey);
});

test('buildLocalChatAgentInput rejects an empty artifact discovery scope', () => {
  assert.throws(
    () => buildTestLocalChatAgentInput({
      context: createContext(),
      userMessage: 'hello',
      threadId: '  ',
    }),
    /requires a non-empty threadId/,
  );
});

test('buildLocalChatAgentInput passes a single toolkit list', () => {
  const generalToolkit = createGeneralToolkit();
  const setup = buildTestLocalChatAgentInput({
    context: createContext(),
    userMessage: 'hello',
    toolkits: [generalToolkit],
  });

  assert.deepEqual(
    setup.input.toolkits?.map((item) => item.name),
    [
      'pet_profile',
      'capability_creator',
      'general-toolkit',
      'artifact_discovery',
    ],
  );
  assert.deepEqual(
    setup.input.capabilities?.find(({ name }) => name === 'general')?.uses,
    ['bash', 'git'],
  );
  assert.equal('capabilityToolkits' in setup.input, false);
});

test('buildLocalChatAgentInput keeps the General Capability permission boundary static', () => {
  const setup = buildTestLocalChatAgentInput({
    context: createContext(),
    userMessage: 'hello',
    toolkits: [createGeneralToolkit()],
  });

  assert.deepEqual(
    setup.input.capabilities?.find(({ name }) => name === 'general')?.uses,
    ['bash', 'git'],
  );
  assert.equal(
    setup.input.capabilities
      ?.find(({ name }) => name === 'general')
      ?.uses.includes('general-toolkit'),
    false,
  );
});

test('buildLocalChatAgentInput dedupes built-in capabilities by name', () => {
  const extraExplore: AgentCapability = {
    name: 'explore',
    description: 'extra explore capability',
    uses: [],
    instructions: defineInstructionDocument({
      content: 'Explore.',
    }),
  };

  const setup = buildTestLocalChatAgentInput({
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

test('buildLocalChatAgentInput retains the host baseline general Capability', () => {
  const setup = buildTestLocalChatAgentInput({
    context: createContext(),
    userMessage: 'hello',
  });

  assert.equal(
    setup.input.capabilities?.filter(({ name }) => name === 'general').length,
    1,
  );
});

test('buildDecisionStructuredOutput selects structured output strategy by provider model family and version', () => {
  const jsonModeCases = [
    ['https://dashscope.aliyuncs.com/compatible-mode/v1', 'qwen3.5-plus'],
    ['https://dashscope.aliyuncs.com/compatible-mode/v1', 'qwen3.7-plus'],
    ['https://dashscope.aliyuncs.com/compatible-mode/v1', 'qwen3.7-max'],
    ['https://dashscope.aliyuncs.com/compatible-mode/v1', 'glm-5'],
    ['https://dashscope.aliyuncs.com/compatible-mode/v1', 'kimi-k2.6'],
    ['https://dashscope.aliyuncs.com/compatible-mode/v1', 'MiniMax-M2.6'],
    ['https://dashscope.aliyuncs.com/compatible-mode/v1', 'stepfun/step-3.7-flash'],
    ['https://dashscope.aliyuncs.com/compatible-mode/v1', 'qwen2.5-turbo'],
    ['https://dashscope.aliyuncs.com/compatible-mode/v1', 'qwen-plus'],
    ['https://dashscope.aliyuncs.com/compatible-mode/v1', 'glm-4.5'],
    ['https://dashscope.aliyuncs.com/compatible-mode/v1', 'kimi-k2.5'],
    ['https://dashscope.aliyuncs.com/compatible-mode/v1', 'MiniMax-M2.5'],
    ['https://workspace-id.cn-beijing.maas.aliyuncs.com/compatible-mode/v1', 'provider-model-with-json-mode'],
  ] as const;
  for (const [baseUrl, model] of jsonModeCases) {
    assert.deepEqual(buildDecisionStructuredOutput({
      apiKey: 'test-key',
      baseUrl,
      model,
    }), {
      method: 'jsonMode',
      autoRepair: { maxRetries: 1 },
    });
  }

  for (const model of ['deepseek-v4-pro', 'deepseek-v4-flash']) {
    assert.deepEqual(buildDecisionStructuredOutput({
      apiKey: 'test-key',
      baseUrl: 'https://api.deepseek.com',
      model,
    }), {
      method: 'functionCalling',
      autoRepair: { maxRetries: 1 },
    });
  }

  for (const [baseUrl, model] of [
    ['https://api.moonshot.ai/v1', 'kimi-k2.6'],
    ['https://api.kimi.com/coding/v1', 'k3'],
    ['https://api.openai.com/v1', 'gpt-5.5'],
    ['https://example-gemini-compatible.test/v1', 'gemini-3.5-flash'],
  ] as const) {
    assert.deepEqual(buildDecisionStructuredOutput({
      apiKey: 'test-key',
      baseUrl,
      model,
    }), {
      method: 'jsonSchema',
      autoRepair: { maxRetries: 1 },
    });
  }

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

  assert.deepEqual(buildDecisionStructuredOutput({
    apiKey: 'test-key',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    model: 'qwen3.7-max',
    structuredOutputAutoRepair: false,
  }), { method: 'jsonMode' });
});

test('buildDecisionStructuredOutput honors the resolved profile strategy before inference', () => {
  assert.deepEqual(buildDecisionStructuredOutput({
    apiKey: 'test-key',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    model: 'custom-model',
    structuredOutputMethod: 'jsonSchema',
  }), {
    method: 'jsonSchema',
    autoRepair: { maxRetries: 1 },
  });
});

test('graph identity distinguishes stable profiles with the same model on different endpoints', () => {
  const profiles = createTestModelProfileRegistry([
    {
      modelProfileId: 'account-a',
      model: 'same-model',
      baseUrl: 'https://account-a.example.test/v1',
    },
    {
      modelProfileId: 'account-b',
      model: 'same-model',
      baseUrl: 'https://account-b.example.test/v1',
    },
  ]);
  const first = buildTestLocalChatAgentInput({
    context: createContext(),
    userMessage: 'hello',
    llmConfig: profiles.resolve('account-a'),
  });
  const second = buildTestLocalChatAgentInput({
    context: createContext(),
    userMessage: 'hello',
    llmConfig: profiles.resolve('account-b'),
  });

  assert.notEqual(first.graphKey, second.graphKey);
  assert.match(first.graphKey, /account-a/);
  assert.match(second.graphKey, /account-b/);
});

test('graph identity isolates session-scoped model input adapters', () => {
  const params = {
    context: createContext(),
    userMessage: 'hello',
  };
  const first = buildTestLocalChatAgentInput({
    ...params,
    sessionContextCacheKey: 'session-a',
  });
  const second = buildTestLocalChatAgentInput({
    ...params,
    sessionContextCacheKey: 'session-b',
  });

  assert.notEqual(first.graphKey, second.graphKey);
});

test('buildLocalChatAgentInput passes global review policy mode to graph input', () => {
  const setup = buildTestLocalChatAgentInput({
    context: createContext(),
    userMessage: 'hello',
    llmConfig: {
      apiKey: 'test-key',
      baseUrl: 'https://api.deepseek.com',
      model: 'deepseek-v4-pro',
      globalReviewPolicyMode: 'auto_authorization',
      autoAuthorizationSafetyLevel: 'relaxed',
      structuredOutputAutoRepair: true,
      structuredOutputRepairMaxRetries: 2,
    },
  });

  assert.deepEqual(setup.input.globalReviewPolicy, {
    mode: 'auto_authorization',
    safetyLevel: 'relaxed',
    structuredOutput: {
      method: 'functionCalling',
      autoRepair: { maxRetries: 2 },
    },
  });
});

test('buildLocalChatAgentInput uses caller-provided workdir', () => {
  const setup = buildTestLocalChatAgentInput({
    context: createContext(),
    userMessage: 'hello',
    workdir: '/tmp/pinpawo-chat-workdir',
  });

  assert.equal(setup.input.workdir, '/tmp/pinpawo-chat-workdir');
  assert.match(setup.input.runtimeEnvironment ?? '', /工作目录：\/tmp\/pinpawo-chat-workdir/);
  assert.doesNotMatch(setup.input.runtimeEnvironment ?? '', /进程 cwd/);
});

test('buildLocalChatAgentInput registers artifact discovery for an empty thread', async (t) => {
  const artifactRoot = mkdtempSync(resolve(tmpdir(), 'pinpawo-agent-channel-artifacts-'));
  t.after(() => rmSync(artifactRoot, { recursive: true, force: true }));
  const store = new FileCapabilityArtifactStore(artifactRoot);
  const setup = buildTestLocalChatAgentInput({
    context: createContext(),
    userMessage: 'hello',
    threadId: 'thread/with space',
    capabilityArtifactStore: store,
    toolkits: [createBashToolkit(), createGitToolkit()],
  });
  const toolkit = setup.input.toolkits?.find(({ name }) => name === 'artifact_discovery');

  assert.ok(toolkit);
  assert.deepEqual(
    toolkit.tools.map((definition) => definition.tool.name),
    ['artifact_list', 'artifact_read'],
  );
  assert.deepEqual(
    setup.input.capabilities?.find(({ name }) => name === 'general')?.uses,
    ['bash', 'git'],
  );
  assert.deepEqual(
    setup.registry.capabilities
      .find(({ capability }) => capability.name === 'general')
      ?.toolNames
      .filter((name) => name === 'artifact_list' || name === 'artifact_read'),
    [],
  );
  assert.ok(
    setup.input.capabilities
      ?.find(({ name }) => name === 'explore')
      ?.uses.includes('artifact_discovery'),
  );
  assert.ok(
    setup.registry.capabilities.some(({ capability }) => capability.name === 'explore'),
    'an empty thread must not make Explore unavailable',
  );

  const list = toolkit.tools.find(({ tool }) => tool.name === 'artifact_list')?.tool;
  assert.ok(list);
  assert.match(String(await list.invoke({})), /no artifacts/);
});

test('artifact discovery sees artifacts written after Toolkit registration', async (t) => {
  const artifactRoot = mkdtempSync(resolve(tmpdir(), 'pinpawo-agent-channel-empty-artifacts-'));
  t.after(() => rmSync(artifactRoot, { recursive: true, force: true }));
  const store = new FileCapabilityArtifactStore(artifactRoot);
  const setup = buildTestLocalChatAgentInput({
    context: createContext(),
    userMessage: 'hello',
    threadId: 'new-thread',
    capabilityArtifactStore: store,
  });
  const toolkit = setup.input.toolkits?.find(({ name }) => name === 'artifact_discovery');
  const list = toolkit?.tools.find(({ tool }) => tool.name === 'artifact_list')?.tool;
  assert.ok(list);

  const ref = await store.writeArtifact({
    threadId: 'new-thread',
    capabilityId: 'explore',
    delegationId: 'delegation-1',
    runId: 'run-1',
    artifact: {
      kind: 'report',
      mimeType: 'text/markdown',
      content: '# Historical report',
    },
  });

  assert.match(String(await list.invoke({})), new RegExp(ref.id));
});

test('artifact discovery rejects an artifact URI from another thread', async (t) => {
  const artifactRoot = mkdtempSync(resolve(tmpdir(), 'pinpawo-agent-channel-scoped-artifacts-'));
  t.after(() => rmSync(artifactRoot, { recursive: true, force: true }));
  const store = new FileCapabilityArtifactStore(artifactRoot);
  const ref = await store.writeArtifact({
    threadId: 'thread-2',
    capabilityId: 'explore',
    delegationId: 'delegation-1',
    runId: 'run-1',
    artifact: {
      kind: 'report',
      mimeType: 'text/markdown',
      content: '# Other thread',
    },
  });
  const setup = buildTestLocalChatAgentInput({
    context: createContext(),
    userMessage: 'hello',
    threadId: 'thread-1',
    capabilityArtifactStore: store,
  });
  const read = setup.input.toolkits
    ?.find(({ name }) => name === 'artifact_discovery')
    ?.tools.find(({ tool }) => tool.name === 'artifact_read')
    ?.tool;

  assert.ok(read);
  assert.match(
    String(await read.invoke({ uri: ref.uri })),
    /belongs to another thread/,
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
  const first = buildTestLocalChatAgentInput(params);
  const second = buildTestLocalChatAgentInput(params);

  assert.equal(first.input.runtimeEnvironment, second.input.runtimeEnvironment);
  assert.match(first.input.runtimeEnvironment ?? '', /会话开始时间：2026-06-23T10:30:00\+08:00/);
  assert.match(first.input.runtimeEnvironment ?? '', /时区：Asia\/Shanghai/);
});
