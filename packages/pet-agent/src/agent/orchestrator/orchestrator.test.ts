import test from 'node:test';
import assert from 'node:assert/strict';
import { AIMessage, HumanMessage } from '@langchain/core/messages';
import { ToolMessage } from '@langchain/core/messages/tool';
import { tool } from '@langchain/core/tools';
import { Command, isCommand, MemorySaver, messagesStateReducer } from '@langchain/langgraph';
import { FakeToolCallingModel } from 'langchain';
import { z } from 'zod';
import type { AgentCapability } from '../../types/capability';
import type { AgentActor, AgentModels } from '../../types/agent';
import type { CapabilityArtifactStore, CapabilityArtifactWriteInput } from '../../types/artifact';
import { defineToolset, type AgentToolkit } from '../../types/toolkit';
import { runAgent } from '../runAgent';
import { buildOrchestratorTurnInput, createOrchestratorGraph } from '../createAgentRuntime';
import {
  capabilitySearchTool,
  searchCapabilities,
  splitCapabilitySearchTerms,
} from './capabilitySearch';
import {
  collectCapabilityOperations,
  collectGeneralOperations,
  collectToolkitOperations,
  readLatestToolArtifact,
  resolveToolkitResources,
  selectCapabilityTools,
} from './subagentHandoff';
import { buildReviewSpec } from './review/reviewSpec';
import { isToolActionAuthorized } from './review/reviewAuthorizations';
import {
  getMessageAnnounce,
  getMessageDelegationId,
  laneMessages,
  laneMessagesForStateUpdate,
  mainConversationMessages,
  readLatestAnnounce,
  setPinpetMeta,
  tagNewLaneMessages,
} from './messageLanes';
import { reuseOrAppendTurnDelegation, updateTurnDelegationResult } from './delegations';
import type { TurnDelegation } from './types';
import { readCapabilityArtifactMarkers } from './capabilityArtifacts';

function capability(name: string, description: string): AgentCapability {
  return {
    name,
    description,
    createRuntime: () => ({}),
  };
}

function mockTool(name: string) {
  return tool(async () => `${name} ok`, {
    name,
    description: `${name} tool`,
    schema: z.object({}),
  });
}

const testActor: AgentActor = {
  petId: 'pet-1',
  userId: 'user-1',
  name: '小白',
  personality: '友好',
  stage: 'adult',
  species: 'cat',
};

test('capability search ranks matching capability and keeps original query terms', () => {
  const results = searchCapabilities('宠物发帖|小红书日常', [
    capability('daily_post', '生成、保存或跳过宠物 daily post、小红书日常动态、宠物发帖草稿。'),
    capability('capability_creator', '生成和验证用户自定义 capability 插件模板。'),
  ]);

  assert.equal(results[0]?.name, 'daily_post');
  assert.deepEqual(results[0]?.matchedTerms, ['宠物发帖', '小红书日常']);
});

test('capability search matches long Chinese intent through contained capability keywords', () => {
  const results = searchCapabilities('根据最新热点生成三条视频脚本', [
    capability('trend_video_script', '视频脚本助手，最新热点，热门短视频，脚本，分镜，图片。'),
    capability('video_tail_audio', '从视频中提取音频并截取最后2秒，生成标准输出目录与metadata.json。'),
  ]);

  assert.equal(results[0]?.name, 'trend_video_script');
  assert.deepEqual(results[0]?.matchedTerms, ['根据最新热点生成三条视频脚本']);
});

test('capability search finds video script assistant for short creation request', () => {
  const results = searchCapabilities('帮我开始写 视频脚本', [
    capability('trend_video_script', '视频脚本助手，视频脚本，最新热点，热门短视频，短视频脚本，分镜脚本，分镜图片。'),
    capability('video_tail_audio', '从视频中提取音频并截取最后2秒，生成标准输出目录与metadata.json。'),
  ]);

  assert.equal(results[0]?.name, 'trend_video_script');
  assert.deepEqual(results.map((item) => item.name), ['trend_video_script']);
});

test('capability search can select explore for read-heavy investigation requests', () => {
  const results = searchCapabilities('代码库理解|调查|先探索再决定', [
    capability('explore', '通用探索、调查、资料检索和代码库理解 capability。适合大量阅读、搜索、检查上下文、梳理证据、先探索再决定下一步的任务。'),
    capability('daily_post', '生成、保存或跳过宠物 daily post、小红书日常动态、宠物发帖草稿。'),
  ]);

  assert.equal(results[0]?.name, 'explore');
});

test('capability search tool returns a state update command with candidates', async () => {
  const capabilities = [
    capability('daily_post', '生成、保存或跳过宠物 daily post、小红书日常动态、宠物发帖草稿。'),
    capability('capability_creator', '生成和验证用户自定义 capability 插件模板。'),
  ];
  const result = await capabilitySearchTool.invoke({
    type: 'tool_call',
    name: 'capability_search',
    id: 'call-1',
    args: { query: ' 宠物发帖|小红书日常 ' },
  }, {
    configurable: { capabilities },
  });

  assert.equal(isCommand(result), true);
  const command = result as unknown as Command<unknown, {
    capabilitySearchState: {
      query: string | null;
      attempted: boolean;
      candidates: { name: string }[];
    };
    messages: { tool_call_id: string }[];
  }>;
  const update = command.update as {
    capabilitySearchState: {
      query: string | null;
      attempted: boolean;
      candidates: { name: string }[];
    };
    messages: { tool_call_id: string }[];
  };
  assert.equal(update.capabilitySearchState.query, '宠物发帖|小红书日常');
  assert.equal(update.capabilitySearchState.attempted, true);
  assert.equal(update.capabilitySearchState.candidates[0]?.name, 'daily_post');
  assert.equal(update.messages[0]?.tool_call_id, 'call-1');
  assert.deepEqual(splitCapabilitySearchTerms('宠物发帖|宠物 发帖'), ['宠物发帖', '宠物 发帖', '宠物', '发帖']);
});

test('capability discovery receives compact task status context', async () => {
  let discoveryInput = '';
  const model = {
    bindTools: () => ({
      invoke: async (messages: unknown[]) => {
        discoveryInput = String((messages.at(-1) as { content?: unknown })?.content ?? '');
        return new AIMessage('');
      },
    }),
    withStructuredOutput: () => ({
      invoke: async () => ({ action: 'finish', answer: 'done' }),
    }),
  } as unknown as AgentModels['act'];

  const graph = createOrchestratorGraph({
    models: { act: model, observe: model },
    actor: testActor,
  });
  const previousAnnounce = new AIMessage('已确认目标目录，打包因超时停止。');
  setPinpetMeta(previousAnnounce, {
    lane: 'general',
    turnId: 'prev-turn',
    announce: 'progress',
    delegationId: 'task-prev',
    task: '归档 Downloads',
  });
  const input = buildOrchestratorTurnInput([
    new HumanMessage('打开 Gmail 登录页面'),
    new AIMessage('Gmail 登录页面已经打开了。'),
    previousAnnounce,
    new HumanMessage('之前的任务完成的怎么样了？'),
  ]);

  await graph.invoke(input, {
    configurable: {
      thread_id: 'test-discovery-latest',
      actor: testActor,
      capabilities: [capability('daily_post', '生成宠物日常动态。')],
      tools: [],
    },
  });

  assert.match(discoveryInput, /当前用户请求：之前的任务完成的怎么样了？/);
  assert.match(discoveryInput, /近期任务状态/);
  assert.match(discoveryInput, /执行器：general；完成进度：progress/);
  assert.match(discoveryInput, /任务目标：归档 Downloads/);
  assert.doesNotMatch(discoveryInput, /最近 subagent announce/);
  assert.doesNotMatch(discoveryInput, /打包因超时停止/);
});

test('user intent decision exposes in-progress capability candidates independent of latest user text', async () => {
  let decisionSystemPrompt = '';
  let decisionInput = '';
  let decisionCallCount = 0;
  let schemaAllowsExplore = false;
  const model = {
    bindTools: () => ({
      invoke: async () => {
        return new AIMessage('');
      },
    }),
    withStructuredOutput: (schema: unknown) => ({
      invoke: async (messages: unknown[]) => {
        decisionCallCount += 1;
        if (decisionCallCount > 1) {
          return { action: 'finish', answer: 'done' };
        }
        schemaAllowsExplore = Boolean(
          (schema as { safeParse?: (value: unknown) => { success: boolean } }).safeParse?.({
            action: 'delegate_capability.explore',
            task: '继续调查 pet-app 仓库中 local-agent 的 capability 注册链路。',
            context_summary: '上一轮 explore 调查仍处于 progress 状态。',
          }).success,
        );
        decisionSystemPrompt = String((messages.at(0) as { content?: unknown })?.content ?? '');
        decisionInput = String((messages.at(-1) as { content?: unknown })?.content ?? '');
        return {
          action: 'delegate_capability.explore',
          task: '继续调查 pet-app 仓库中 local-agent 的 capability 注册链路。',
          context_summary: '上一轮 explore 调查仍处于 progress 状态。',
        };
      },
    }),
  } as unknown as AgentModels['act'];

  const graph = createOrchestratorGraph({
    models: {
      act: model,
      observe: model,
      subagent: new FakeToolCallingModel({ toolCalls: [[]] }),
    },
    actor: testActor,
  });
  const previousAnnounce = new AIMessage('(no matches)');
  setPinpetMeta(previousAnnounce, {
    lane: 'capability:explore',
    turnId: 'prev-turn',
    announce: 'progress',
    delegationId: 'task-prev',
    task: '调查 pet-app 仓库中 local-agent 的 capability 注册链路，列出关键文件和证据。',
  });
  const input = buildOrchestratorTurnInput([
    new HumanMessage('帮我调查 pet-app 里的 capability 注册链路。'),
    previousAnnounce,
    new HumanMessage('现在状态如何？'),
  ]);

  await graph.invoke(input, {
    configurable: {
      thread_id: 'test-in-progress-capability-candidate',
      actor: testActor,
      capabilities: [capability('explore', '通用探索、调查、代码库理解 capability。')],
      tools: [],
    },
  });

  assert.equal(schemaAllowsExplore, true);
  assert.match(decisionSystemPrompt, /delegate_capability\.explore/);
  assert.match(decisionInput, /当前用户请求：现在状态如何？/);
  assert.match(decisionInput, /capability:explore，progress/);
  assert.match(decisionInput, /调查 pet-app 仓库中 local-agent 的 capability 注册链路/);
  assert.equal(decisionCallCount, 2);
});

test('forcedCapabilityNames pre-seeds capability candidates and skips capability discovery LLM call', async () => {
  let discoveryCalled = false;
  let decisionSystemPrompt = '';
  const decisionPayload: Record<string, unknown> = { action: 'finish', answer: 'done' };
  const model = {
    bindTools: () => ({
      invoke: async () => {
        discoveryCalled = true;
        return new AIMessage('');
      },
    }),
    withStructuredOutput: () => ({
      invoke: async (messages: unknown[]) => {
        decisionSystemPrompt = String((messages.at(0) as { content?: unknown })?.content ?? '');
        return decisionPayload;
      },
    }),
  } as unknown as AgentModels['act'];

  const graph = createOrchestratorGraph({
    models: { act: model, observe: model },
    actor: testActor,
  });
  const input = buildOrchestratorTurnInput([new HumanMessage('做一支讲秋日食材的短视频')]);

  await graph.invoke(input, {
    configurable: {
      thread_id: 'forced-cap-thread',
      actor: testActor,
      capabilities: [
        capability('studio_plan', 'Planner 唯一的目标:把用户请求拆解为一份 plan。'),
        capability('other_cap', '某个无关 capability。'),
      ],
      tools: [],
      forcedCapabilityNames: ['studio_plan'],
    },
  });

  assert.equal(discoveryCalled, false, 'discovery LLM call must be short-circuited when forced names present');
  assert.match(decisionSystemPrompt, /delegate_capability\.studio_plan/);
  // 仅强制 studio_plan,other_cap 不应被作为候选注入。
  assert.doesNotMatch(decisionSystemPrompt, /delegate_capability\.other_cap/);
});

test('without forcedCapabilityNames the discovery path runs as before (no-regression)', async () => {
  let discoveryCalled = false;
  const model = {
    bindTools: () => ({
      invoke: async () => {
        discoveryCalled = true;
        // 不发起 capability_search tool_call,让 graph 走完;后续 userIntentDecision 直接 finish。
        return new AIMessage('');
      },
    }),
    withStructuredOutput: () => ({
      invoke: async () => ({ action: 'finish', answer: 'done' }),
    }),
  } as unknown as AgentModels['act'];

  const graph = createOrchestratorGraph({
    models: { act: model, observe: model },
    actor: testActor,
  });
  const input = buildOrchestratorTurnInput([new HumanMessage('做一支讲秋日食材的短视频')]);

  await graph.invoke(input, {
    configurable: {
      thread_id: 'no-forced-cap-thread',
      actor: testActor,
      capabilities: [capability('studio_plan', 'Planner 唯一的目标:把用户请求拆解为一份 plan。')],
      tools: [],
      // forcedCapabilityNames 未传 —— 走通用 pet agent 老路径
    },
  });

  assert.equal(discoveryCalled, true, 'discovery LLM call must run when no forced names provided');
});

test('delegation outcome decision receives subagent announce as explicit input and skips discovery', async () => {
  let discoveryCalled = false;
  let decisionInput = '';
  const model = {
    bindTools: () => ({
      invoke: async () => {
        discoveryCalled = true;
        return new AIMessage('');
      },
    }),
    withStructuredOutput: () => ({
      invoke: async (messages: unknown[]) => {
        decisionInput = String((messages.at(-1) as { content?: unknown })?.content ?? '');
        return { action: 'finish', answer: 'done' };
      },
    }),
  } as unknown as AgentModels['act'];

  const graph = createOrchestratorGraph({
    models: { act: model, observe: model },
    actor: testActor,
  });
  const currentAnnounce = new AIMessage('文件读取完成，lint 已通过。');
  const input = buildOrchestratorTurnInput([
    new HumanMessage('读取文件并运行 lint'),
    currentAnnounce,
  ]);
  setPinpetMeta(currentAnnounce, {
    lane: 'general',
    turnId: input.turnId,
    announce: 'completed',
    delegationId: 'task-1',
    task: '读取文件并运行 lint',
  });
  input.turnDelegations = [{
    id: 'task-1',
    lane: 'general',
    task: '读取文件并运行 lint',
    status: 'completed',
    resultPreview: '文件读取完成，lint 已通过。',
  }];

  await graph.invoke(input, {
    configurable: {
      thread_id: 'test-delegation-outcome',
      actor: testActor,
      capabilities: [capability('daily_post', '生成宠物日常动态。')],
      tools: [],
    },
  });

  assert.equal(discoveryCalled, false);
  assert.match(decisionInput, /subagent announce/);
  assert.match(decisionInput, /文件读取完成，lint 已通过/);
});

test('limit-reached progress announce lets model choose the same capability delegation', async () => {
  let capabilityRunCount = 0;
  let decisionCallCount = 0;
  let decisionSystemPrompt = '';
  let decisionInput = '';
  const routeModel = {
    bindTools: () => ({
      invoke: async () => {
        throw new Error('capability discovery should be skipped for current-turn announce');
      },
    }),
    withStructuredOutput: () => ({
      invoke: async (messages: unknown[]) => {
        decisionCallCount += 1;
        if (decisionCallCount === 1) {
          decisionSystemPrompt = String((messages.at(0) as { content?: unknown })?.content ?? '');
          decisionInput = String((messages.at(-1) as { content?: unknown })?.content ?? '');
          return {
            action: 'delegate_capability.inspect_repo',
            task: '继续调查仓库 capability 注册链路。',
            context_summary: '上一轮因迭代上限停止，任务仍未完成。',
          };
        }
        return { action: 'finish', answer: 'done' };
      },
    }),
  } as unknown as AgentModels['act'];
  const inspectCapability: AgentCapability = {
    name: 'inspect_repo',
    description: 'Inspect repository.',
    createRuntime: () => {
      capabilityRunCount += 1;
      return {};
    },
  };
  const graph = createOrchestratorGraph({
    models: {
      act: routeModel,
      observe: routeModel,
      subagent: new FakeToolCallingModel({ toolCalls: [[]] }),
    },
    actor: testActor,
  });
  const input = buildOrchestratorTurnInput([new HumanMessage('继续')]);
  const progressAnnounce = new AIMessage('(no matches)');
  setPinpetMeta(progressAnnounce, {
    lane: 'capability:inspect_repo',
    turnId: input.turnId,
    announce: 'progress',
    completionReason: 'limit_reached',
    delegationId: 'task-limit',
    task: '调查仓库 capability 注册链路。',
  });
  input.messages.push(progressAnnounce);
  input.turnDelegations = [{
    id: 'task-limit',
    lane: 'capability:inspect_repo',
    task: '调查仓库 capability 注册链路。',
    status: 'progress',
    resultPreview: '(no matches)',
  }];

  await graph.invoke(input, {
    configurable: {
      thread_id: 'limit-progress-auto-resume',
      actor: testActor,
      capabilities: [inspectCapability],
      toolkits: [],
    },
  });

  assert.equal(capabilityRunCount, 1);
  assert.equal(decisionCallCount, 2);
  assert.match(decisionSystemPrompt, /delegate_capability\.inspect_repo/);
  assert.match(decisionInput, /停止原因：limit_reached/);
});

test('capability result helper reads latest tool artifact, not JSON content', () => {
  const result = readLatestToolArtifact([
    new ToolMessage({
      content: '{"status":"failed","postId":"wrong"}',
      artifact: { status: 'created', postId: 'post-1' },
      tool_call_id: 'call-1',
    }),
  ]);

  assert.deepEqual(result, { status: 'created', postId: 'post-1' });
});

test('toolkits compose tools and instructions for capability runtimes', async () => {
  const browserOpen = mockTool('browser_open');
  const readFile = mockTool('read_file');
  const customTool = mockTool('custom_tool');
  const toolkits: AgentToolkit[] = [
    {
      name: 'browser',
      description: 'browser toolkit',
      tools: [browserOpen],
      instructions: ['browser rules'],
    },
    {
      name: 'bash',
      description: 'bash toolkit',
      tools: [readFile],
      instructions: ['bash rules'],
    },
  ];

  const browserResources = await resolveToolkitResources(toolkits, ['browser'], {
    models: {} as AgentModels,
    actor: testActor,
    messages: [],
  });
  const allResources = await resolveToolkitResources(toolkits, undefined, {
    models: {} as AgentModels,
    actor: testActor,
    messages: [],
  });

  assert.deepEqual(browserResources.tools.map((toolItem) => toolItem.name), ['browser_open']);
  assert.deepEqual(browserResources.instructions, ['browser rules']);
  assert.deepEqual(allResources.tools.map((toolItem) => toolItem.name), ['browser_open', 'read_file']);

  const selectedTools = selectCapabilityTools({
    uses: ['browser'],
    toolsets: [{
      name: 'private',
      tools: [customTool],
    }],
  }, browserResources.tools);

  assert.deepEqual(selectedTools.map((toolItem) => toolItem.name), [
    'browser_open',
    'custom_tool',
  ]);

  const dedupedTools = selectCapabilityTools({
    uses: ['browser'],
    toolsets: [
      {
        name: 'private',
        tools: [customTool],
      },
      {
        name: 'private_duplicate',
        tools: [customTool],
      },
    ],
  }, browserResources.tools);

  assert.deepEqual(dedupedTools.map((toolItem) => toolItem.name), [
    'browser_open',
    'custom_tool',
  ]);
});

test('capability runtime receives available toolkit metadata and fixed uses still resolve normally', async () => {
  let routeCallCount = 0;
  let runtimeToolkitNames: string[] = [];
  const routeModel = {
    bindTools: () => ({
      invoke: async () => new AIMessage(''),
    }),
    withStructuredOutput: () => ({
      invoke: async () => {
        routeCallCount += 1;
        return routeCallCount === 1
          ? {
              action: 'delegate_capability.inspect_repo',
              task: 'inspect repository',
              context_summary: null,
            }
          : {
              action: 'finish',
              answer: 'done',
            };
      },
    }),
  } as unknown as AgentModels['act'];
  const subagentModel = new FakeToolCallingModel({ toolCalls: [[]] });
  const runtimeCapability: AgentCapability = {
    name: 'inspect_repo',
    description: 'Inspect repository with bash tools.',
    createRuntime: async (ctx) => {
      runtimeToolkitNames = ctx.availableToolkits?.map((item) => item.name) ?? [];
      return {
        uses: ['bash'],
        instructions: (instructionCtx) => [
          `available=${instructionCtx.availableToolkits?.map((item) => item.name).join(',') ?? ''}`,
        ],
      };
    },
  };
  const graph = createOrchestratorGraph({
    models: {
      act: routeModel,
      observe: routeModel,
      subagent: subagentModel,
    },
    actor: testActor,
  });

  await graph.invoke(buildOrchestratorTurnInput([new HumanMessage('inspect')]), {
    configurable: {
      thread_id: 'available-toolkits-runtime',
      actor: testActor,
      capabilities: [runtimeCapability],
      toolkits: [
        {
          name: 'bash',
          description: 'bash toolkit',
          tools: [mockTool('read_file')],
        },
        {
          name: 'browser',
          description: 'browser toolkit',
          tools: [mockTool('browser_open')],
        },
      ],
      forcedCapabilityNames: ['inspect_repo'],
    },
  });

  assert.deepEqual(runtimeToolkitNames, ['bash', 'browser']);
});

test('toolkit and capability toolset operations are collected with their source', () => {
  const toolkits: AgentToolkit[] = [{
    name: 'bash',
    description: 'bash toolkit',
    operations: {
      read_file: {
        title: 'Read File',
      },
      shared_tool: {},
    },
  }];

  const toolkitOperations = collectToolkitOperations(toolkits);
  assert.equal(toolkitOperations.read_file?.title, 'Read File');
  assert.deepEqual(toolkitOperations.read_file?.source, {
    provider: 'toolkit',
    name: 'bash',
    toolName: 'read_file',
  });

  const capabilityOperations = collectCapabilityOperations(toolkits, {
    toolsets: [{
      name: 'private',
      tools: [],
      operations: {
        custom_tool: {},
        shared_tool: {},
      },
    }],
  });

  assert.deepEqual(capabilityOperations.custom_tool?.source, {
    provider: 'toolset',
    name: 'private',
    toolName: 'custom_tool',
  });
  assert.deepEqual(capabilityOperations.shared_tool?.source, {
    provider: 'toolkit',
    name: 'bash',
    toolName: 'shared_tool',
  });
});

test('general operations are collected from toolkits', () => {
  const generalOperations = collectGeneralOperations([{
    name: 'bash',
    description: 'bash toolkit',
    operations: {
      read_file: {},
    },
  }]);

  assert.deepEqual(generalOperations.read_file?.source, {
    provider: 'toolkit',
    name: 'bash',
    toolName: 'read_file',
  });
});

test('capability artifact marker helper reads valid pinpawo markers only', () => {
  const message = new AIMessage({
    content: 'artifact ready',
    additional_kwargs: {
      pinpawo: {
        capabilityArtifacts: [
          {
            kind: 'report',
            mimeType: 'text/markdown',
            title: 'Explore report',
            preview: 'Found prior evidence.',
            content: '# Report',
            schema: { name: 'ExploreReport', version: 1 },
            metadata: { sourceCount: 3 },
          },
          {
            kind: 'unknown',
            mimeType: 'text/plain',
          },
          {
            kind: 'image',
          },
        ],
      },
    },
  });

  assert.deepEqual(readCapabilityArtifactMarkers(message), [{
    kind: 'report',
    mimeType: 'text/markdown',
    title: 'Explore report',
    preview: 'Found prior evidence.',
    content: '# Report',
    schema: { name: 'ExploreReport', version: 1 },
    metadata: { sourceCount: 3 },
    sourceUri: undefined,
    existingUri: undefined,
  }]);
});

test('capability artifact markers are persisted as state refs through host store', async () => {
  let routeCallCount = 0;
  const writes: CapabilityArtifactWriteInput[] = [];
  const store: CapabilityArtifactStore = {
    writeArtifact: async (input) => {
      writes.push(input);
      return {
        id: `artifact-${writes.length}`,
        threadId: input.threadId,
        capabilityId: input.capabilityId,
        delegationId: input.delegationId,
        turnId: input.turnId,
        kind: input.marker.kind,
        mimeType: input.marker.mimeType,
        uri: `capability-artifact://thread/${encodeURIComponent(input.threadId)}/artifact/${writes.length}`,
        title: input.marker.title,
        preview: input.marker.preview,
        sizeBytes: JSON.stringify(input.marker.content ?? '').length,
        createdAt: '2026-06-16T00:00:00.000Z',
        schema: input.marker.schema,
        metadata: input.marker.metadata,
      };
    },
  };
  const routeModel = {
    bindTools: () => ({
      invoke: async () => new AIMessage(''),
    }),
    withStructuredOutput: () => ({
      invoke: async () => {
        routeCallCount += 1;
        return routeCallCount === 1
          ? {
              action: 'delegate_capability.explore',
              task: 'inspect issue context',
              context_summary: null,
            }
          : {
              action: 'finish',
              answer: 'done',
            };
      },
    }),
  } as unknown as AgentModels['act'];
  const fixtureCapability: AgentCapability = {
    name: 'explore',
    description: 'Explore issue context.',
    createRuntime: () => ({
      middleware: {
        afterRun: (result) => ({
          ...result,
          messages: [
            ...result.messages,
            new AIMessage({
              content: 'report stored',
              additional_kwargs: {
                pinpawo: {
                  capabilityArtifacts: [{
                    kind: 'report',
                    mimeType: 'text/markdown',
                    title: 'Issue exploration',
                    preview: 'Checked the artifact handoff path.',
                    content: '# Issue exploration',
                    schema: { name: 'ExploreReport', version: 1 },
                    metadata: { sourceCount: 2 },
                  }],
                },
              },
            }),
          ],
        }),
      },
    }),
  };
  const graph = createOrchestratorGraph({
    models: {
      act: routeModel,
      observe: routeModel,
      subagent: new FakeToolCallingModel({ toolCalls: [[]] }),
    },
    actor: testActor,
    capabilityArtifactStore: store,
  });

  const state = await graph.invoke(buildOrchestratorTurnInput([new HumanMessage('explore issue')]), {
    configurable: {
      thread_id: 'artifact-thread',
      actor: testActor,
      capabilities: [fixtureCapability],
      forcedCapabilityNames: ['explore'],
    },
  });

  assert.equal(writes.length, 1);
  assert.equal(writes[0]?.threadId, 'artifact-thread');
  assert.equal(writes[0]?.capabilityId, 'explore');
  assert.equal(writes[0]?.marker.kind, 'report');
  assert.equal(state.capabilityArtifacts.length, 1);
  assert.equal(state.capabilityArtifacts[0]?.title, 'Issue exploration');
  assert.equal(state.capabilityArtifacts[0]?.uri, 'capability-artifact://thread/artifact-thread/artifact/1');
});

test('schema-validated capability result is also persisted as a JSON result artifact', async () => {
  let routeCallCount = 0;
  const writes: CapabilityArtifactWriteInput[] = [];
  const store: CapabilityArtifactStore = {
    writeArtifact: async (input) => {
      writes.push(input);
      return {
        id: `artifact-${writes.length}`,
        threadId: input.threadId,
        capabilityId: input.capabilityId,
        delegationId: input.delegationId,
        turnId: input.turnId,
        kind: input.marker.kind,
        mimeType: input.marker.mimeType,
        uri: `capability-artifact://thread/${input.threadId}/artifact/${writes.length}`,
        title: input.marker.title,
        preview: input.marker.preview,
        sizeBytes: JSON.stringify(input.marker.content ?? '').length,
        createdAt: '2026-06-16T00:00:00.000Z',
        schema: input.marker.schema,
      };
    },
  };
  const routeModel = {
    bindTools: () => ({
      invoke: async () => new AIMessage(''),
    }),
    withStructuredOutput: () => ({
      invoke: async () => {
        routeCallCount += 1;
        return routeCallCount === 1
          ? {
              action: 'delegate_capability.daily_post',
              task: 'create post',
              context_summary: null,
            }
          : {
              action: 'finish',
              answer: 'done',
            };
      },
    }),
  } as unknown as AgentModels['act'];
  const fixtureCapability: AgentCapability = {
    name: 'daily_post',
    description: 'Create post.',
    resultSchema: z.object({
      status: z.literal('created'),
      postId: z.string(),
    }),
    createRuntime: () => ({
      middleware: {
        afterRun: (result) => ({
          ...result,
          messages: [
            ...result.messages,
            new AIMessage({
              content: 'created post',
              additional_kwargs: {
                pinpawo: {
                  capabilityArtifacts: [{
                    kind: 'result',
                    mimeType: 'application/json',
                    title: 'Daily post result',
                    preview: 'created post-1',
                    content: { status: 'created', postId: 'post-1' },
                    schema: { name: 'daily_post.result', version: 1 },
                  }],
                },
              },
            }),
          ],
        }),
      },
    }),
  };
  const graph = createOrchestratorGraph({
    models: {
      act: routeModel,
      observe: routeModel,
      subagent: new FakeToolCallingModel({ toolCalls: [[]] }),
    },
    actor: testActor,
    capabilityArtifactStore: store,
  });

  const state = await graph.invoke(buildOrchestratorTurnInput([new HumanMessage('post')]), {
    configurable: {
      thread_id: 'result-artifact-thread',
      actor: testActor,
      capabilities: [fixtureCapability],
      forcedCapabilityNames: ['daily_post'],
    },
  });

  assert.deepEqual(state.capabilityResult, { status: 'created', postId: 'post-1' });
  assert.equal(writes.length, 1);
  assert.equal(writes[0]?.marker.kind, 'result');
  assert.equal(writes[0]?.marker.mimeType, 'application/json');
  assert.deepEqual(writes[0]?.marker.content, { status: 'created', postId: 'post-1' });
  assert.equal(state.capabilityArtifacts[0]?.kind, 'result');
  assert.equal(state.capabilityArtifacts[0]?.schema?.name, 'daily_post.result');
});

test('invalid capability result markers are not persisted as artifacts', async () => {
  let routeCallCount = 0;
  const writes: CapabilityArtifactWriteInput[] = [];
  const store: CapabilityArtifactStore = {
    writeArtifact: async (input) => {
      writes.push(input);
      return {
        id: `artifact-${writes.length}`,
        threadId: input.threadId,
        capabilityId: input.capabilityId,
        delegationId: input.delegationId,
        turnId: input.turnId,
        kind: input.marker.kind,
        mimeType: input.marker.mimeType,
        uri: `capability-artifact://thread/${input.threadId}/artifact/${writes.length}`,
        sizeBytes: 0,
        createdAt: '2026-06-16T00:00:00.000Z',
      };
    },
  };
  const routeModel = {
    bindTools: () => ({
      invoke: async () => new AIMessage(''),
    }),
    withStructuredOutput: () => ({
      invoke: async () => {
        routeCallCount += 1;
        return routeCallCount === 1
          ? {
              action: 'delegate_capability.daily_post',
              task: 'create post',
              context_summary: null,
            }
          : {
              action: 'finish',
              answer: 'done',
            };
      },
    }),
  } as unknown as AgentModels['act'];
  const fixtureCapability: AgentCapability = {
    name: 'daily_post',
    description: 'Create post.',
    resultSchema: z.object({
      status: z.literal('created'),
      postId: z.string(),
    }),
    createRuntime: () => ({
      middleware: {
        afterRun: (result) => ({
          ...result,
          messages: [
            ...result.messages,
            new AIMessage({
              content: 'invalid post result',
              additional_kwargs: {
                pinpawo: {
                  capabilityArtifacts: [{
                    kind: 'result',
                    mimeType: 'application/json',
                    content: { status: 'failed', postId: null },
                  }],
                },
              },
            }),
          ],
        }),
      },
    }),
  };
  const graph = createOrchestratorGraph({
    models: {
      act: routeModel,
      observe: routeModel,
      subagent: new FakeToolCallingModel({ toolCalls: [[]] }),
    },
    actor: testActor,
    capabilityArtifactStore: store,
  });

  const state = await graph.invoke(buildOrchestratorTurnInput([new HumanMessage('post')]), {
    configurable: {
      thread_id: 'invalid-result-artifact-thread',
      actor: testActor,
      capabilities: [fixtureCapability],
      forcedCapabilityNames: ['daily_post'],
    },
  });

  assert.equal(state.capabilityResult, null);
  assert.equal(writes.length, 0);
  assert.equal(state.capabilityArtifacts.length, 0);
});

test('runAgent omits empty toolkit configurable arrays', async () => {
  const calls: Array<{ configurable?: Record<string, unknown> }> = [];
  const graph = {
    invoke: async (_input: unknown, options?: { configurable?: Record<string, unknown> }) => {
      calls.push({ configurable: options?.configurable });
      return { messages: [new AIMessage('done')] };
    },
  };

  const result = await runAgent(graph as never, {
    messages: [new HumanMessage('hello')],
    toolkits: [],
  });

  assert.equal(result.reply, 'done');
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.configurable?.toolkits, undefined);
});

test('capability toolset runtimes expose operation metadata', async () => {
  const saveDraftTool = tool(async () => 'ok', {
    name: 'save_draft',
    description: 'save a draft',
    schema: z.object({
      topic: z.string(),
      content: z.string(),
    }),
  });
  const fixtureCapability: AgentCapability = {
    name: 'draft_writer',
    description: 'Test capability with private toolset metadata.',
    createRuntime: () => ({
      toolsets: [defineToolset({
        name: 'draft_writer',
        description: 'Draft writer private tools.',
        tools: [saveDraftTool] as const,
        operations: {
          save_draft: {
            title: '保存草稿',
            summarizeInput: (input) => {
              const value = input && typeof input === 'object'
                ? input as { topic?: unknown; content?: unknown }
                : {};
              return {
                target: typeof value.topic === 'string' ? value.topic : undefined,
                summary: '保存草稿',
                details: {
                  contentLength: typeof value.content === 'string' ? value.content.length : undefined,
                },
              };
            },
          },
        },
      })],
    }),
  };

  const runtime = await fixtureCapability.createRuntime({
    models: {} as AgentModels,
    actor: testActor,
    messages: [],
  });
  const toolset = runtime.toolsets?.find((item) => item.name === 'draft_writer');

  assert.equal(toolset?.operations?.save_draft?.title, '保存草稿');
  assert.deepEqual(collectCapabilityOperations([], runtime).save_draft?.source, {
    provider: 'toolset',
    name: 'draft_writer',
    toolName: 'save_draft',
  });

  const summary = toolset?.operations?.save_draft?.summarizeInput?.({
    content: '这是一段待发布的正文',
    topic: '早餐',
  });
  assert.equal(summary?.target, '早餐');
  assert.equal(summary?.summary, '保存草稿');
  assert.deepEqual(summary?.details, {
    contentLength: '这是一段待发布的正文'.length,
  });
  assert.equal(JSON.stringify(summary).includes('这是一段待发布的正文'), false);
});

test('toolkit review policy wraps tool calls without changing tool identity', async () => {
  let callCount = 0;
  let reviewCount = 0;
  const rawTool = tool(async () => {
    callCount += 1;
    return 'raw ok';
  }, {
    name: 'safe_tool',
    description: 'safe tool',
    schema: z.object({}),
  });
  const toolkits: AgentToolkit[] = [{
    name: 'guarded',
    description: 'guarded toolkit',
    tools: [rawTool],
    policy: {
      toolReview: {
        safe_tool: {
          request: () => {
            reviewCount += 1;
            return null;
          },
        },
      },
    },
  }];

  const resources = await resolveToolkitResources(toolkits, ['guarded'], {
    models: {} as AgentModels,
    actor: testActor,
    messages: [],
  });

  assert.equal(resources.tools[0]?.name, 'safe_tool');
  assert.equal(resources.tools[0]?.description, 'safe tool');

  const result = await resources.tools[0]?.invoke({});
  assert.equal(reviewCount, 1);
  assert.equal(callCount, 1);
  assert.equal(result, 'raw ok');
});

test('toolkit review policy records authorization through orchestrator runtime topology', async () => {
  let runCount = 0;
  let reviewCount = 0;
  const rawTool = tool(async ({ command }: { command: string }) => {
    runCount += 1;
    return `ran ${command}`;
  }, {
    name: 'run_shell',
    description: 'run shell',
    schema: z.object({ command: z.string() }),
  });
  const toolkits: AgentToolkit[] = [{
    name: 'local',
    description: 'local tools',
    tools: [rawTool],
    policy: {
      toolReview: {
        run_shell: {
          request: ({ input, toolAuthorizations }) => {
            const args = input as { command: string };
            if (isToolActionAuthorized({
              authorizations: toolAuthorizations ?? [],
              toolName: 'run_shell',
              args,
            })) {
              return null;
            }
            reviewCount += 1;
            return buildReviewSpec({
              view: { kind: 'plain', body: 'Approve shell?' },
              options: [{
                id: 'approve-and-authorize-thread',
                label: 'Approve and authorize',
                decision: { type: 'approve' },
                effects: [{
                  type: 'graph.authorize_tool_action',
                  scope: 'thread',
                  actionRef: { type: 'pending_action' },
                  matcher: { type: 'policy_hook' },
                }],
              }],
            });
          },
          buildAuthorizationMatcher: ({ input }) => ({
            type: 'shell_pattern',
            value: (input as { command: string }).command,
          }),
        },
      },
    },
  }];

  let routeCallCount = 0;
  const runtimeEvents: unknown[] = [];
  const routeModel = {
    bindTools: () => ({
      invoke: async () => new AIMessage(''),
    }),
    withStructuredOutput: () => ({
      invoke: async () => {
        routeCallCount += 1;
        return routeCallCount === 1
          ? {
              action: 'delegate_general',
              task: 'run shell',
              context_summary: null,
            }
          : {
              action: 'finish',
              answer: 'done',
            };
      },
    }),
  } as unknown as AgentModels['act'];
  const subagentModel = new FakeToolCallingModel({
    toolCalls: [
      [{
        id: 'call-1',
        name: 'run_shell',
        args: { command: 'git status' },
      }],
      [{
        id: 'call-2',
        name: 'run_shell',
        args: { command: 'git status' },
      }],
      [],
    ],
  });
  const graph = createOrchestratorGraph({
    models: {
      act: routeModel,
      observe: routeModel,
      subagent: subagentModel,
    },
    actor: testActor,
    checkpoint: new MemorySaver(),
  });
  const config = {
    configurable: {
      thread_id: 'canonical-review-runtime-auth',
      actor: testActor,
      capabilities: [],
      toolkits,
      onToolEvent: (event: unknown) => {
        runtimeEvents.push(event);
      },
    },
  };
  const input = buildOrchestratorTurnInput([new HumanMessage('run git status')]);

  const interrupted = await graph.invoke(input, config) as {
    __interrupt__?: Array<{ value?: unknown }>;
  };
  const payload = interrupted.__interrupt__?.[0]?.value as {
    review?: { id?: string };
  } | undefined;
  assert.equal(payload?.review?.id, 'tool-review:run_shell:call-1');
  assert.equal(reviewCount, 1);

  subagentModel.index = 0;
  const finalState = await graph.invoke(new Command({
    resume: {
      reviewId: payload?.review?.id,
      selectedOptionId: 'approve-and-authorize-thread',
    },
  }), config) as {
    __interrupt__?: unknown;
    toolAuthorizations: Array<{ toolName: string; matcher: unknown; createdAt: string }>;
  };

  assert.equal(finalState.__interrupt__, undefined);
  assert.deepEqual(finalState.toolAuthorizations.map(({ createdAt: _createdAt, ...item }) => item), [{
    toolName: 'run_shell',
    matcher: { type: 'shell_pattern', value: 'git status' },
  }]);
  const authorizationEvents = runtimeEvents.filter((event) =>
    event
    && typeof event === 'object'
    && (event as { event?: unknown }).event === 'on_runtime_event'
    && (event as { name?: unknown }).name === 'tool_authorization_recorded');
  assert.equal(authorizationEvents.length, 1);
  const eventData = (authorizationEvents[0] as { data?: { authorizations?: unknown[] } }).data;
  const eventAuthorizations = eventData?.authorizations as Array<{
    toolName: string;
    matcher: unknown;
    createdAt: string;
  }>;
  assert.deepEqual(eventAuthorizations.map(({ createdAt: _createdAt, ...item }) => item), [{
    toolName: 'run_shell',
    matcher: { type: 'shell_pattern', value: 'git status' },
  }]);
  assert.equal(reviewCount, 2);
  assert.equal(runCount, 1);
});

test('toolkit review policy resumes plain approve through interrupt checkpoint', async () => {
  let runCount = 0;
  let reviewCount = 0;
  const rawTool = tool(async ({ command }: { command: string }) => {
    runCount += 1;
    return `ran ${command}`;
  }, {
    name: 'run_shell',
    description: 'run shell',
    schema: z.object({ command: z.string() }),
  });
  const toolkits: AgentToolkit[] = [{
    name: 'local',
    description: 'local tools',
    tools: [rawTool],
    policy: {
      toolReview: {
        run_shell: {
          request: () => {
            reviewCount += 1;
            return buildReviewSpec({
              view: { kind: 'plain', body: 'Approve shell once?' },
              options: [{
                id: 'approve',
                label: 'Approve',
                decision: { type: 'approve' },
              }],
            });
          },
        },
      },
    },
  }];

  let routeCallCount = 0;
  const routeModel = {
    bindTools: () => ({
      invoke: async () => new AIMessage(''),
    }),
    withStructuredOutput: () => ({
      invoke: async () => {
        routeCallCount += 1;
        return routeCallCount === 1
          ? {
              action: 'delegate_general',
              task: 'run shell',
              context_summary: null,
            }
          : {
              action: 'finish',
              answer: 'done',
            };
      },
    }),
  } as unknown as AgentModels['act'];
  const subagentModel = new FakeToolCallingModel({
    toolCalls: [
      [{
        id: 'call-plain-1',
        name: 'run_shell',
        args: { command: 'git status' },
      }],
      [],
    ],
  });
  const graph = createOrchestratorGraph({
    models: {
      act: routeModel,
      observe: routeModel,
      subagent: subagentModel,
    },
    actor: testActor,
    checkpoint: new MemorySaver(),
  });
  const config = {
    configurable: {
      thread_id: 'plain-review-runtime-state',
      actor: testActor,
      capabilities: [],
      toolkits,
    },
  };

  const interrupted = await graph.invoke(
    buildOrchestratorTurnInput([new HumanMessage('run git status')]),
    config,
  ) as {
    __interrupt__?: Array<{ value?: unknown }>;
  };
  const payload = interrupted.__interrupt__?.[0]?.value as {
    review?: { id?: string };
  } | undefined;
  assert.equal(payload?.review?.id, 'tool-review:run_shell:call-plain-1');

  subagentModel.index = 0;
  const finalState = await graph.invoke(new Command({
    resume: {
      reviewId: payload?.review?.id,
      selectedOptionId: 'approve',
    },
  }), config) as {
    __interrupt__?: unknown;
    messages: Array<AIMessage | HumanMessage | ToolMessage>;
    turnId: string;
  };

  assert.equal(finalState.__interrupt__, undefined);
  assert.equal(reviewCount, 2);
  assert.equal(runCount, 1);
  const announce = readLatestAnnounce(finalState.messages, { turnId: finalState.turnId });
  assert.equal(announce?.announce, 'progress');
  assert.ok(announce?.delegationId);
  assert.ok(
    laneMessages(finalState.messages, 'general', finalState.turnId, announce.delegationId)
      .some((message) => message.content === 'ran git status'),
  );
});

test('iteration limit review emits canonical ReviewSpec interrupt payload', async () => {
  const graph = createOrchestratorGraph({
    models: {} as AgentModels,
    actor: testActor,
    checkpoint: new MemorySaver(),
  });
  const input = buildOrchestratorTurnInput([new HumanMessage('继续处理')]);
  input.iterationCount = 1;

  const result = await graph.invoke(input, {
    configurable: {
      thread_id: 'iteration-limit-review-spec',
      actor: testActor,
      capabilities: [],
      tools: [],
      maxIterations: 1,
    },
  }) as {
    __interrupt__?: Array<{ value?: unknown }>;
  };
  const payload = result.__interrupt__?.[0]?.value as {
    kind?: string;
    review?: { id?: string; schemaVersion?: number; options?: Array<{ id: string }> };
    pendingAction?: { toolName?: string };
    actionRequests?: unknown;
    reviewConfigs?: unknown;
  } | undefined;

  assert.equal(payload?.kind, 'review');
  assert.equal(payload?.review?.id, `iteration-limit:${input.turnId}:1:1`);
  assert.equal(payload?.review?.schemaVersion, 1);
  assert.deepEqual(payload?.review?.options?.map((option) => option.id), ['approve', 'reject', 'respond']);
  assert.equal(payload?.pendingAction, undefined);
  assert.equal(payload?.actionRequests, undefined);
  assert.equal(payload?.reviewConfigs, undefined);
});

test('iteration limit review id is scoped to the turn id', async () => {
  const graph = createOrchestratorGraph({
    models: {} as AgentModels,
    actor: testActor,
    checkpoint: new MemorySaver(),
  });
  const inputA = buildOrchestratorTurnInput([new HumanMessage('继续处理')]);
  const inputB = buildOrchestratorTurnInput([new HumanMessage('继续处理')]);
  inputA.turnId = 'turn-a';
  inputB.turnId = 'turn-b';
  inputA.iterationCount = 1;
  inputB.iterationCount = 1;

  const readInterruptedReviewId = async (
    input: typeof inputA,
    threadId: string,
  ): Promise<string | undefined> => {
    const result = await graph.invoke(input, {
      configurable: {
        thread_id: threadId,
        actor: testActor,
        capabilities: [],
        tools: [],
        maxIterations: 1,
      },
    }) as {
      __interrupt__?: Array<{ value?: unknown }>;
    };
    return (result.__interrupt__?.[0]?.value as {
      review?: { id?: string };
    } | undefined)?.review?.id;
  };

  const idA = await readInterruptedReviewId(inputA, 'iteration-limit-turn-a');
  const idB = await readInterruptedReviewId(inputB, 'iteration-limit-turn-b');

  assert.equal(idA, 'iteration-limit:turn-a:1:1');
  assert.equal(idB, 'iteration-limit:turn-b:1:1');
  assert.notEqual(idA, idB);
});

test('iteration limit review accepts canonical approve resume', async () => {
  const finishModel = {
    withStructuredOutput: () => ({
      invoke: async () => ({
        action: 'finish',
        answer: 'done',
      }),
    }),
  } as unknown as AgentModels['act'];
  const graph = createOrchestratorGraph({
    models: { act: finishModel },
    actor: testActor,
    checkpoint: new MemorySaver(),
  });
  const input = buildOrchestratorTurnInput([new HumanMessage('继续处理')]);
  input.iterationCount = 1;
  const config = {
    configurable: {
      thread_id: 'iteration-limit-canonical-approve',
      actor: testActor,
      capabilities: [],
      tools: [],
      maxIterations: 1,
    },
  };

  const interrupted = await graph.invoke(input, config) as {
    __interrupt__?: Array<{ value?: unknown }>;
  };
  const payload = interrupted.__interrupt__?.[0]?.value as {
    review?: { id?: string };
  } | undefined;
  assert.equal(typeof payload?.review?.id, 'string');

  const resumed = await graph.invoke(new Command({
    resume: {
      reviewId: payload?.review?.id,
      selectedOptionId: 'approve',
    },
  }), config) as {
    __interrupt__?: unknown;
    iterationCount?: number;
  };

  assert.equal(Array.isArray(resumed.__interrupt__) ? resumed.__interrupt__.length : 0, 0);
  assert.equal(resumed.iterationCount, 0);
});

test('iteration limit approve can resume an in-progress capability lane', async () => {
  let schemaAllowsExplore = false;
  const routeModel = {
    withStructuredOutput: (schema: unknown) => ({
      invoke: async () => {
        schemaAllowsExplore = Boolean(
          (schema as { safeParse?: (value: unknown) => { success: boolean } }).safeParse?.({
            action: 'delegate_capability.explore',
            task: '继续调查 pet-app 仓库中 local-agent 的 capability 注册链路。',
            context_summary: '上一轮 explore lane 仍处于 progress。',
          }).success,
        );
        return {
          action: 'delegate_capability.explore',
          task: '继续调查 pet-app 仓库中 local-agent 的 capability 注册链路。',
          context_summary: '上一轮 explore lane 仍处于 progress。',
        };
      },
    }),
  } as unknown as AgentModels['act'];
  const graph = createOrchestratorGraph({
    models: { act: routeModel },
    actor: testActor,
    checkpoint: new MemorySaver(),
  });
  const previousAnnounce = new AIMessage('已定位到部分 registry 文件，但还没有完成完整调用链路调查。');
  setPinpetMeta(previousAnnounce, {
    lane: 'capability:explore',
    turnId: 'previous-turn',
    announce: 'progress',
    completionReason: 'limit_reached',
    delegationId: 'previous-progress-1',
    task: '调查 pet-app 仓库中 local-agent 的 capability 注册链路，列出关键文件和证据。',
  });
  const input = buildOrchestratorTurnInput([
    new HumanMessage('帮我调查 pet-app 仓库中 local-agent 的 capability 注册链路，列出关键文件和证据。'),
    previousAnnounce,
    new HumanMessage('继续'),
  ]);
  input.iterationCount = 1;
  const config = {
    configurable: {
      thread_id: 'iteration-limit-capability-resume',
      actor: testActor,
      capabilities: [capability('explore', '通用探索、调查、代码库理解 capability。')],
      tools: [],
      maxIterations: 1,
    },
  };

  const interrupted = await graph.invoke(input, config) as {
    __interrupt__?: Array<{ value?: unknown }>;
  };
  const payload = interrupted.__interrupt__?.[0]?.value as {
    review?: { id?: string };
  } | undefined;
  assert.equal(typeof payload?.review?.id, 'string');

  const resumed = await graph.invoke(new Command({
    resume: {
      reviewId: payload?.review?.id,
      selectedOptionId: 'approve',
    },
  }), {
    ...config,
    interruptBefore: ['capability'],
  }) as {
    __interrupt__?: unknown;
    iterationCount?: number;
    pendingDelegation?: { lane?: string; task?: string } | null;
  };

  assert.equal(Array.isArray(resumed.__interrupt__) ? resumed.__interrupt__.length : 0, 0);
  assert.equal(resumed.iterationCount, 0);
  assert.equal(schemaAllowsExplore, true);
  assert.equal(resumed.pendingDelegation?.lane, 'capability:explore');
  assert.match(resumed.pendingDelegation?.task ?? '', /继续调查/);
});

test('iteration limit review accepts canonical respond resume as replanning feedback', async () => {
  let decisionInput = '';
  const finishModel = {
    withStructuredOutput: () => ({
      invoke: async (messages: Array<{ content?: unknown }>) => {
        decisionInput = String(messages.at(-1)?.content ?? '');
        return {
          action: 'finish',
          answer: 'done after feedback',
        };
      },
    }),
  } as unknown as AgentModels['act'];
  const graph = createOrchestratorGraph({
    models: { act: finishModel },
    actor: testActor,
    checkpoint: new MemorySaver(),
  });
  const input = buildOrchestratorTurnInput([new HumanMessage('继续处理')]);
  input.iterationCount = 1;
  const config = {
    configurable: {
      thread_id: 'iteration-limit-canonical-respond',
      actor: testActor,
      capabilities: [],
      tools: [],
      maxIterations: 1,
    },
  };

  const interrupted = await graph.invoke(input, config) as {
    __interrupt__?: Array<{ value?: unknown }>;
  };
  const payload = interrupted.__interrupt__?.[0]?.value as {
    review?: { id?: string };
  } | undefined;
  assert.equal(typeof payload?.review?.id, 'string');

  const resumed = await graph.invoke(new Command({
    resume: {
      reviewId: payload?.review?.id,
      selectedOptionId: 'respond',
      input: { message: '继续，但只做摘要。' },
    },
  }), config) as {
    __interrupt__?: unknown;
    iterationCount?: number;
  };

  assert.equal(resumed.__interrupt__, undefined);
  assert.equal(resumed.iterationCount, 0);
  assert.match(decisionInput, /继续，但只做摘要。/);
});

test('lane tagging hides subagent messages from route and records completed announce', () => {
  const messages = [
    new HumanMessage('帮我查一下小红书动态'),
    new AIMessage('已查到热门动态。'),
  ];

  const tagged = tagNewLaneMessages(messages, 1, 'general', 'turn-1', 'natural', {
    delegationId: 'task-1',
    task: '查小红书动态',
  });

  assert.equal(tagged.length, 1);
  assert.equal(getMessageAnnounce(messages[1]), 'completed');
  assert.equal(getMessageDelegationId(messages[1]), 'task-1');
  assert.deepEqual(mainConversationMessages(messages).map((message) => message.content), ['帮我查一下小红书动态']);
  assert.deepEqual(laneMessages(messages, 'general', 'turn-1', 'task-1').map((message) => message.content), [
    '帮我查一下小红书动态',
    '已查到热门动态。',
  ]);
  assert.deepEqual(readLatestAnnounce(messages, { delegationId: 'task-1' }), {
    lane: 'general',
    delegationId: 'task-1',
    task: '查小红书动态',
    announce: 'completed',
    text: '已查到热门动态。',
  });
});

test('lane tagging marks limit-reached result as progress', () => {
  const messages = [
    new HumanMessage('读取文件并运行 lint'),
    new AIMessage('文件读取完成，lint 还没跑。'),
  ];

  tagNewLaneMessages(messages, 1, 'general', 'turn-1', 'limit_reached', {
    delegationId: 'task-2',
    task: '读取文件并运行 lint',
  });

  assert.equal(getMessageAnnounce(messages[1]), 'progress');
  assert.deepEqual(readLatestAnnounce(messages, { delegationId: 'task-2' }), {
    lane: 'general',
    delegationId: 'task-2',
    task: '读取文件并运行 lint',
    announce: 'progress',
    text: '文件读取完成，lint 还没跑。',
  });
});

test('completed lane state update keeps only the announce from the current run', () => {
  const human = new HumanMessage('检查项目并汇报');
  const toolCall = new AIMessage({
    content: '先读取 package.json。',
    tool_calls: [{ id: 'call-read', name: 'read_file', args: { path: 'package.json' } }],
  });
  const toolResult = new ToolMessage({
    content: '{"scripts":{"test":"node --test"}}',
    tool_call_id: 'call-read',
  });
  const note = new AIMessage('已经确认测试脚本。');
  const announce = new AIMessage('检查完成，测试脚本是 node --test。');
  const outputMessages = [human, toolCall, toolResult, note, announce];

  const tagged = tagNewLaneMessages(outputMessages, 1, 'general', 'turn-1', 'natural', {
    delegationId: 'task-complete',
    task: '检查项目并汇报',
  });
  const update = laneMessagesForStateUpdate({
    existingMessages: [human],
    outputMessages: tagged,
    lane: 'general',
    turnId: 'turn-1',
    delegationId: 'task-complete',
  });
  const stateMessages = messagesStateReducer([human], update);

  assert.deepEqual(stateMessages.map((message) => message.content), [
    '检查项目并汇报',
    '检查完成，测试脚本是 node --test。',
  ]);
  assert.equal(getMessageAnnounce(stateMessages[1]), 'completed');
  assert.equal(getMessageDelegationId(stateMessages[1]), 'task-complete');
});

test('completed continuation removes old progress transcript for the same delegation', () => {
  const human = new HumanMessage('处理所有分片');
  const oldToolCall = new AIMessage({
    content: '处理第一个分片。',
    tool_calls: [{ id: 'call-old', name: 'process_next_chunk', args: { source: 'items.csv' } }],
  });
  const oldToolResult = new ToolMessage({
    content: '第一个分片完成，还有剩余。',
    tool_call_id: 'call-old',
  });
  const oldProgress = new AIMessage('已处理第一个分片，尚未完成。');
  const previousRun = [human, oldToolCall, oldToolResult, oldProgress];
  const previousUpdate = tagNewLaneMessages(previousRun, 1, 'general', 'turn-1', 'limit_reached', {
    delegationId: 'task-resume',
    task: '处理所有分片',
  });
  const stateWithProgress = messagesStateReducer([human], previousUpdate);
  assert.equal(laneMessages(stateWithProgress, 'general', 'turn-1', 'task-resume').length, 4);

  const finalNote = new AIMessage('继续处理剩余分片。');
  const completedAnnounce = new AIMessage('全部分片已处理完成，共 120 条。');
  const continuationOutput = [
    ...laneMessages(stateWithProgress, 'general', 'turn-1', 'task-resume'),
    finalNote,
    completedAnnounce,
  ];
  const taggedContinuation = tagNewLaneMessages(
    continuationOutput,
    stateWithProgress.length,
    'general',
    'turn-1',
    'natural',
    {
      delegationId: 'task-resume',
      task: '处理所有分片',
    },
  );
  const foldedUpdate = laneMessagesForStateUpdate({
    existingMessages: stateWithProgress,
    outputMessages: taggedContinuation,
    lane: 'general',
    turnId: 'turn-1',
    delegationId: 'task-resume',
  });
  const finalState = messagesStateReducer(stateWithProgress, foldedUpdate);

  assert.deepEqual(laneMessages(finalState, 'general', 'turn-1', 'task-resume').map((message) => message.content), [
    '处理所有分片',
    '全部分片已处理完成，共 120 条。',
  ]);
  assert.deepEqual(readLatestAnnounce(finalState, { delegationId: 'task-resume' }), {
    lane: 'general',
    delegationId: 'task-resume',
    task: '处理所有分片',
    announce: 'completed',
    text: '全部分片已处理完成，共 120 条。',
  });
});

test('lane messages drop unanswered tool calls from interrupted subagent history', () => {
  const human = new HumanMessage('归档 Downloads');
  const completeToolCall = new AIMessage({
    content: '先检查目标目录。',
    tool_calls: [{ id: 'call-1', name: 'stat_path', args: { path: '/tmp' } }],
  });
  const toolResult = new ToolMessage({
    content: '{"ok":true}',
    tool_call_id: 'call-1',
  });
  const unansweredToolCall = new AIMessage({
    content: '继续移动文件。',
    tool_calls: [{ id: 'call-2', name: 'move_path', args: { source: 'a', destination: 'b' } }],
  });
  const messages = [human, completeToolCall, toolResult, unansweredToolCall];

  const tagged = tagNewLaneMessages(messages, 1, 'general', 'turn-1', 'limit_reached', {
    delegationId: 'task-3',
    task: '归档 Downloads',
  });
  const stateMessages = [human, ...tagged];

  assert.deepEqual(stateMessages.map((message) => message.content), [
    '归档 Downloads',
    '先检查目标目录。',
    '{"ok":true}',
  ]);
  assert.equal(getMessageAnnounce(toolResult), 'progress');
  assert.deepEqual(readLatestAnnounce(stateMessages, { delegationId: 'task-3' }), {
    lane: 'general',
    delegationId: 'task-3',
    task: '归档 Downloads',
    announce: 'progress',
    text: '{"ok":true}',
  });
});

test('lane messages sanitize legacy checkpoint history with dangling tool calls', () => {
  const human = new HumanMessage('继续归档');
  const danglingToolCall = new AIMessage({
    content: '准备移动。',
    tool_calls: [{ id: 'call-legacy', name: 'move_path', args: { source: 'a', destination: 'b' } }],
  });
  setPinpetMeta(danglingToolCall, { lane: 'general', turnId: 'turn-1', delegationId: 'task-legacy' });

  assert.deepEqual(laneMessages([human, danglingToolCall], 'general', 'turn-1', 'task-legacy').map((message) => message.content), [
    '继续归档',
  ]);
});

test('lane messages scope to delegation: new task starts clean, reused id carries over', () => {
  const human = new HumanMessage('帮我整理仓库');
  const task1ToolCall = new AIMessage({
    content: '先看一下目录。',
    tool_calls: [{ id: 'call-t1', name: 'list_dir', args: { path: '.' } }],
  });
  const task1ToolResult = new ToolMessage({
    content: '{"entries":["a.ts"]}',
    tool_call_id: 'call-t1',
  });
  const task1Answer = new AIMessage('目录已整理完成。');
  const messages = [human, task1ToolCall, task1ToolResult, task1Answer];

  tagNewLaneMessages(messages, 1, 'general', 'turn-1', 'natural', {
    delegationId: 'task-1',
    task: '整理仓库',
  });

  // 同 turn 同 lane 的新 task：看不到上一个 task 的 transcript，只剩主对话。
  assert.deepEqual(laneMessages(messages, 'general', 'turn-1', 'task-2').map((message) => message.content), [
    '帮我整理仓库',
  ]);

  // 同一 delegation 续跑（复用 delegationId）：全量带回自己的 transcript。
  assert.deepEqual(laneMessages(messages, 'general', 'turn-1', 'task-1').map((message) => message.content), [
    '帮我整理仓库',
    '先看一下目录。',
    '{"entries":["a.ts"]}',
    '目录已整理完成。',
  ]);
});

test('lane messages exclude legacy lane history without per-message delegationId', () => {
  const human = new HumanMessage('继续');
  const legacyLaneMessage = new AIMessage('旧版本写入的 lane 消息。');
  setPinpetMeta(legacyLaneMessage, { lane: 'general', turnId: 'turn-1' });

  assert.deepEqual(laneMessages([human, legacyLaneMessage], 'general', 'turn-1', 'task-1').map((message) => message.content), [
    '继续',
  ]);
});

test('delegation helpers reuse progress delegation and update result', () => {
  const delegations: TurnDelegation[] = [
    {
      id: 'task-1',
      lane: 'general',
      task: '读取文件',
      status: 'progress',
      resultPreview: '已读取部分文件',
    },
  ];

  const reused = reuseOrAppendTurnDelegation(delegations, {
    id: 'task-2',
    lane: 'general',
    task: '继续读取文件并运行 lint',
    contextSummary: '继续完成用户当前请求。',
  });

  assert.equal(reused.pendingDelegation?.id, 'task-1');
  assert.equal(reused.pendingDelegation?.task, '继续读取文件并运行 lint');
  assert.equal(reused.turnDelegations.length, 1);
  assert.equal(reused.turnDelegations[0].task, '继续读取文件并运行 lint');
  assert.equal(reused.turnDelegations[0].status, 'pending');

  const completed = updateTurnDelegationResult(reused.turnDelegations, 'task-1', {
    status: 'completed',
    resultPreview: '任务完成',
  });
  assert.equal(completed[0].status, 'completed');
  assert.equal(completed[0].resultPreview, '任务完成');
});
