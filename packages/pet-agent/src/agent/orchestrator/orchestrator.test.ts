import test from 'node:test';
import assert from 'node:assert/strict';
import { AIMessage, HumanMessage } from '@langchain/core/messages';
import { ToolMessage } from '@langchain/core/messages/tool';
import { tool } from '@langchain/core/tools';
import { Command, isCommand } from '@langchain/langgraph';
import { z } from 'zod';
import type { AgentCapability } from '../../types/capability';
import type { AgentActor, AgentModels } from '../../types/agent';
import type { AgentToolkit } from '../../types/toolkit';
import { createCapabilityCreatorCapability } from '../../capabilities/capabilityCreator/index';
import { createDailyPostCapability } from '../../capabilities/dailyPost/index';
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
  collectRuntimeOperations,
  collectToolkitOperations,
  readLatestToolArtifact,
  resolveToolkitResources,
  selectCapabilityTools,
} from './subagentHandoff';
import {
  buildHumanReviewRequest,
  buildHumanReviewResume,
  readFirstHumanReviewDecision,
} from './humanReview';
import {
  getMessageAnnounce,
  getMessageDelegationId,
  laneMessages,
  mainConversationMessages,
  readLatestAnnounce,
  setPinpetMeta,
  tagNewLaneMessages,
} from './messageLanes';
import { reuseOrAppendTurnDelegation, updateTurnDelegationResult } from './delegations';
import type { TurnDelegation } from './types';

function capability(name: string, description: string): AgentCapability {
  return {
    name,
    description,
    createRuntime: () => ({ tools: [] }),
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
    toolsets: [{
      name: 'private',
      tools: [customTool],
    }],
    tools: [customTool],
  }, browserResources.tools);

  assert.deepEqual(dedupedTools.map((toolItem) => toolItem.name), [
    'browser_open',
    'custom_tool',
  ]);
});

test('toolkit and capability toolset operations are collected with their source', () => {
  const toolkits: AgentToolkit[] = [{
    name: 'bash',
    description: 'bash toolkit',
    operations: {
      read_file: {
        kind: 'file.read',
        title: 'Read File',
      },
      shared_tool: {
        kind: 'toolkit.shared',
      },
    },
  }];

  const toolkitOperations = collectToolkitOperations(toolkits);
  assert.equal(toolkitOperations.read_file?.kind, 'file.read');
  assert.deepEqual(toolkitOperations.read_file?.source, {
    provider: 'toolkit',
    name: 'read_file',
  });

  const capabilityOperations = collectCapabilityOperations(toolkits, {
    toolsets: [{
      name: 'private',
      tools: [],
      operations: {
        custom_tool: {
          kind: 'capability.custom',
        },
        shared_tool: {
          kind: 'capability.shared',
        },
      },
    }],
  });

  assert.equal(capabilityOperations.custom_tool?.kind, 'capability.custom');
  assert.deepEqual(capabilityOperations.custom_tool?.source, {
    provider: 'capability',
    name: 'custom_tool',
  });
  assert.equal(capabilityOperations.shared_tool?.kind, 'toolkit.shared');
});

test('runtime tool operations are collected for host-provided tools', () => {
  const legacyRuntimeOperations = collectRuntimeOperations({
    describe_pet_profile: {
      kind: 'pet.profile.read',
      title: '读取宠物资料',
    },
  });

  assert.equal(legacyRuntimeOperations.describe_pet_profile?.kind, 'pet.profile.read');
  assert.deepEqual(legacyRuntimeOperations.describe_pet_profile?.source, {
    provider: 'runtime',
    name: 'describe_pet_profile',
  });

  const generalOperations = collectGeneralOperations([{
    name: 'bash',
    description: 'bash toolkit',
    operations: {
      read_file: {
        kind: 'file.read',
      },
    },
  }], {
    describe_pet_profile: {
      kind: 'pet.profile.read',
    },
    read_file: {
      kind: 'legacy.file.read',
    },
  });

  assert.equal(generalOperations.read_file?.kind, 'file.read');
  assert.deepEqual(generalOperations.read_file?.source, {
    provider: 'toolkit',
    name: 'read_file',
  });
  assert.equal(generalOperations.describe_pet_profile?.kind, 'pet.profile.read');
});

test('runAgent omits empty direct tool and toolkit configurable arrays', async () => {
  const calls: Array<{ configurable?: Record<string, unknown> }> = [];
  const graph = {
    invoke: async (_input: unknown, options?: { configurable?: Record<string, unknown> }) => {
      calls.push({ configurable: options?.configurable });
      return { messages: [new AIMessage('done')] };
    },
  };

  const result = await runAgent(graph as never, {
    messages: [new HumanMessage('hello')],
    tools: [],
    toolkits: [],
  });

  assert.equal(result.reply, 'done');
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.configurable?.tools, undefined);
  assert.equal(calls[0]?.configurable?.toolkits, undefined);
});

test('built-in capability runtimes expose operation metadata', async () => {
  const dailyPost = createDailyPostCapability({
    savePost: async () => ({ postId: 'post-1' }),
  });
  const dailyPostRuntime = await dailyPost.createRuntime({
    models: {} as AgentModels,
    actor: testActor,
    messages: [],
  });
  const dailyPostToolset = dailyPostRuntime.toolsets?.find((toolset) => toolset.name === 'daily_post');

  assert.equal(dailyPostToolset?.operations?.finalize_post?.kind, 'daily_post.finalize');
  assert.equal(dailyPostToolset?.operations?.skip_post?.kind, 'daily_post.skip');
  assert.equal(collectCapabilityOperations([], dailyPostRuntime).finalize_post?.source?.provider, 'capability');

  const finalizeSummary = dailyPostToolset?.operations?.finalize_post?.summarizeInput?.({
    mode: 'original',
    content: '这是一段待发布的正文',
    topic: '早餐',
    tags: ['日常'],
    citations: ['trend-1'],
    requestImage: true,
  });
  assert.equal(finalizeSummary?.target, '早餐');
  assert.equal(finalizeSummary?.summary, '保存原创动态');
  assert.deepEqual(finalizeSummary?.details, {
    mode: 'original',
    topic: '早餐',
    requestImage: true,
    contentLength: '这是一段待发布的正文'.length,
    tagCount: 1,
    citationCount: 1,
  });
  assert.equal(JSON.stringify(finalizeSummary).includes('这是一段待发布的正文'), false);

  const creatorRuntime = await createCapabilityCreatorCapability().createRuntime({
    models: {} as AgentModels,
    actor: testActor,
    messages: [],
  });
  const creatorToolset = creatorRuntime.toolsets?.find((toolset) => toolset.name === 'capability_creator');

  assert.equal(creatorToolset?.operations?.scaffold_capability_plugin?.kind, 'capability.scaffold');
  assert.equal(creatorToolset?.operations?.validate_capability_plugin?.kind, 'capability.validate');
  assert.equal(creatorToolset?.operations?.check_capability_keywords?.kind, 'capability.keyword_check');
  assert.equal(collectCapabilityOperations([], creatorRuntime).scaffold_capability_plugin?.source?.provider, 'capability');
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

test('human review helpers use structured decisions', () => {
  const request = buildHumanReviewRequest({
    actionRequests: [{
      name: 'run_shell',
      args: { command: 'rm -rf tmp' },
      description: 'Delete tmp',
    }],
    reviewConfigs: [{
      actionName: 'run_shell',
      allowedDecisions: ['approve', 'edit', 'reject'],
    }],
    prompt: 'Approve shell command?',
  });

  assert.equal(request.kind, 'human_review');
  assert.equal(request.actionRequests[0]?.name, 'run_shell');
  assert.deepEqual(
    readFirstHumanReviewDecision(buildHumanReviewResume([{ type: 'approve' }])),
    { type: 'approve' },
  );
  assert.deepEqual(
    readFirstHumanReviewDecision({
      decisions: [{
        type: 'edit',
        editedAction: {
          name: 'run_shell',
          args: { command: 'ls tmp' },
        },
      }],
    }),
    {
      type: 'edit',
      editedAction: {
        name: 'run_shell',
        args: { command: 'ls tmp' },
      },
    },
  );
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
  assert.deepEqual(laneMessages(messages, 'general', 'turn-1').map((message) => message.content), [
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
  setPinpetMeta(danglingToolCall, { lane: 'general', turnId: 'turn-1' });

  assert.deepEqual(laneMessages([human, danglingToolCall], 'general', 'turn-1').map((message) => message.content), [
    '继续归档',
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
