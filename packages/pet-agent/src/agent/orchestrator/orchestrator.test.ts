import test from 'node:test';
import assert from 'node:assert/strict';
import { AIMessage, HumanMessage, SystemMessage } from '@langchain/core/messages';
import { ToolMessage } from '@langchain/core/messages/tool';
import { tool } from '@langchain/core/tools';
import { FakeListChatModel } from '@langchain/core/utils/testing';
import { Command, isCommand, MemorySaver, messagesStateReducer } from '@langchain/langgraph';
import { FakeToolCallingModel } from 'langchain';
import { z } from 'zod';
import type { AgentCapability } from '../../types/capability';
import type { AgentActor, AgentModels } from '../../types/agent';
import { defineToolset, type AgentToolkit } from '../../types/toolkit';
import { runAgent } from '../runAgent';
import { buildOrchestratorRunInput, createOrchestratorGraph } from '../createAgentRuntime';
import {
  capabilitySearchTool,
  searchCapabilities,
  splitCapabilitySearchTerms,
} from './capabilitySearch';
import {
  collectCapabilityOperations,
  collectGeneralOperations,
  collectToolkitOperations,
  resolveToolkitResources,
  selectCapabilityTools,
} from './subagentHandoff';
import { buildReviewSpec } from './review/reviewSpec';
import { isToolActionAuthorized } from './review/reviewAuthorizations';
import { ReviewPolicies } from './review/reviewPolicies';
import {
  buildSubagentHandoff,
  getMessageDelegationId,
  getMessageHandoffSource,
  getMessageIsAnnounce,
  getMessageLane,
  laneMessages,
  mainConversationMessages,
  readLatestAnnounce,
  readRecentAnnounces,
  readMessageCreatedAtUtc,
  setPinpetMeta,
  tagNewLaneMessages,
} from './messageLanes';
import { RemoveMessage } from '@langchain/core/messages';
import { reuseOrAppendRunDelegation, updateRunDelegationResult } from './delegations';
import { CONTEXT_COMPACTION_MESSAGE_NAME } from './contextCompaction';
import type { RunDelegation, TaskActiveDelegation } from './types';
import type { OrchestratorStateType } from './state';

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
    runCapabilitySearchState: {
      query: string | null;
      attempted: boolean;
      candidates: { name: string }[];
    };
    messages: { tool_call_id: string }[];
  }>;
  const update = command.update as {
    runCapabilitySearchState: {
      query: string | null;
      attempted: boolean;
      candidates: { name: string }[];
    };
    messages: { tool_call_id: string }[];
  };
  assert.equal(update.runCapabilitySearchState.query, '宠物发帖|小红书日常');
  assert.equal(update.runCapabilitySearchState.attempted, true);
  assert.equal(update.runCapabilitySearchState.candidates[0]?.name, 'daily_post');
  assert.equal(update.messages[0]?.tool_call_id, 'call-1');
  assert.deepEqual(splitCapabilitySearchTerms('宠物发帖|宠物 发帖'), ['宠物发帖', '宠物 发帖', '宠物', '发帖']);
});

test('capability discovery receives compact task status context', async () => {
  let discoveryInput = '';
  const model = {
    invoke: async () => new AIMessage('answered'),
    bindTools: () => ({
      invoke: async (messages: unknown[]) => {
        discoveryInput = String((messages.at(-1) as { content?: unknown })?.content ?? '');
        return new AIMessage('');
      },
    }),
    withStructuredOutput: () => ({
      invoke: async () => ({ action: 'answer' }),
    }),
  } as unknown as AgentModels['act'];

  const graph = createOrchestratorGraph({
    models: { act: model, observe: model },
    actor: testActor,
  });
  const previousAnnounce = new AIMessage('已确认目标目录，打包因超时停止。');
  setPinpetMeta(previousAnnounce, {
    lane: 'general',
    runId: 'prev-turn',
    isAnnounce: true,
    delegationId: 'task-prev',
    task: '归档 Downloads',
  });
  const input = buildOrchestratorRunInput([
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
  assert.match(discoveryInput, /执行器：general/);
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
    invoke: async () => new AIMessage('answered'),
    bindTools: () => ({
      invoke: async () => {
        return new AIMessage('');
      },
    }),
    withStructuredOutput: (schema: unknown) => ({
      invoke: async (messages: unknown[]) => {
        decisionCallCount += 1;
        if (decisionCallCount > 1) {
          return { action: 'answer' };
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
    runId: 'prev-turn',
    isAnnounce: true,
    delegationId: 'task-prev',
    task: '调查 pet-app 仓库中 local-agent 的 capability 注册链路，列出关键文件和证据。',
  });
  const input = buildOrchestratorRunInput([
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
  assert.doesNotMatch(decisionSystemPrompt, /ask_user/);
  assert.match(decisionInput, /<user_intent_decision_input>/);
  assert.match(decisionInput, /<user_request>\n\s+<!\[CDATA\[\n现在状态如何？\n\s+\]\]>\n\s+<\/user_request>/);
  assert.match(decisionInput, /capability:explore/);
  assert.match(decisionInput, /调查 pet-app 仓库中 local-agent 的 capability 注册链路/);
  assert.equal(decisionCallCount, 2);
});

test('decision structured output autoRepair reruns the same route LLM call after invalid shape', async () => {
  const invokedMessages: unknown[] = [];
  let invokeCount = 0;
  let capturedOptions: unknown;
  const model = {
    invoke: async () => new AIMessage('answered'),
    withStructuredOutput: (_schema: unknown, options: unknown) => {
      capturedOptions = options;
      return {
        invoke: async (messages: unknown[]) => {
          invokeCount += 1;
          invokedMessages.push(messages);
          return invokeCount === 1
            ? { action: 'not_allowed' }
            : { action: 'answer' };
        },
      };
    },
  } as unknown as AgentModels['act'];

  const graph = createOrchestratorGraph({
    models: { act: model, observe: model },
    actor: testActor,
    decisionStructuredOutput: {
      method: 'jsonMode',
      autoRepair: true,
    },
  });
  const input = buildOrchestratorRunInput([new HumanMessage('hello')]);

  const state = await graph.invoke(input, {
    configurable: {
      thread_id: 'decision-auto-repair',
      actor: testActor,
      capabilities: [],
      tools: [],
    },
  });

  assert.equal(invokeCount, 2);
  assert.equal(invokedMessages[0], invokedMessages[1]);
  assert.deepEqual(capturedOptions, {
    name: 'orchestration_decision',
    method: 'jsonMode',
  });
  // After the retry resolves to answer, the dedicated answer node produces the reply.
  assert.equal(mainConversationMessages(state.messages).at(-1)?.content, 'answered');
});

test('user intent decision without candidates does not advertise capability actions', async () => {
  let decisionSystemPrompt = '';
  let schemaAllowsBrowser = false;
  const model = {
    invoke: async () => new AIMessage('done'),
    bindTools: () => ({
      invoke: async () => new AIMessage(''),
    }),
    withStructuredOutput: (schema: unknown) => ({
      invoke: async (messages: unknown[]) => {
        schemaAllowsBrowser = Boolean(
          (schema as { safeParse?: (value: unknown) => { success: boolean } }).safeParse?.({
            action: 'delegate_capability.browser',
            task: '打开网页',
            context_summary: '用户需要浏览器。',
          }).success,
        );
        decisionSystemPrompt = String((messages.at(0) as { content?: unknown })?.content ?? '');
        return { action: 'answer' };
      },
    }),
  } as unknown as AgentModels['act'];

  const graph = createOrchestratorGraph({
    models: { act: model, observe: model },
    actor: testActor,
  });

  await graph.invoke(buildOrchestratorRunInput([
    new HumanMessage('继续'),
  ]), {
    configurable: {
      thread_id: 'test-no-candidate-decision-prompt',
      actor: testActor,
      capabilities: [capability('browser', '浏览器 capability。')],
      tools: [],
    },
  });

  assert.equal(schemaAllowsBrowser, false);
  assert.match(decisionSystemPrompt, /本 run 没有业务 capability candidate 进入当前 action schema/);
  assert.match(decisionSystemPrompt, /如果仍需要工具执行，选择 delegate_general/);
  assert.doesNotMatch(decisionSystemPrompt, /调用 capability_search/);
  assert.doesNotMatch(decisionSystemPrompt, /delegate_capability\.browser/);
});

test('forcedCapabilityNames pre-seeds capability candidates and skips capability discovery LLM call', async () => {
  let discoveryCalled = false;
  let decisionSystemPrompt = '';
  const decisionPayload: Record<string, unknown> = { action: 'answer' };
  const model = {
    invoke: async () => new AIMessage('answered'),
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
  const input = buildOrchestratorRunInput([new HumanMessage('做一支讲秋日食材的短视频')]);

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
    invoke: async () => new AIMessage('answered'),
    bindTools: () => ({
      invoke: async () => {
        discoveryCalled = true;
        // 不发起 capability_search tool_call,让 graph 走完;后续 userIntentDecision 直接 answer。
        return new AIMessage('');
      },
    }),
    withStructuredOutput: () => ({
      invoke: async () => ({ action: 'answer' }),
    }),
  } as unknown as AgentModels['act'];

  const graph = createOrchestratorGraph({
    models: { act: model, observe: model },
    actor: testActor,
  });
  const input = buildOrchestratorRunInput([new HumanMessage('做一支讲秋日食材的短视频')]);

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

test('a prior subagent announce reaches the decision as context and the answer node un-clipped', async () => {
  let decisionInput = '';
  let answerInput = '';
  const model = {
    invoke: async (messages: unknown[]) => {
      answerInput = (messages as Array<{ content?: unknown }>)
        .map((m) => String(m?.content ?? ''))
        .join('\n');
      return new AIMessage('answered');
    },
    bindTools: () => ({
      invoke: async () => new AIMessage(''),
    }),
    withStructuredOutput: () => ({
      invoke: async (messages: unknown[]) => {
        decisionInput = String((messages.at(-1) as { content?: unknown })?.content ?? '');
        return { action: 'answer' };
      },
    }),
  } as unknown as AgentModels['act'];

  const graph = createOrchestratorGraph({
    models: { act: model, observe: model },
    actor: testActor,
  });
  const currentAnnounceText = [
    '文件读取完成，lint 已通过。',
    'A'.repeat(1400),
    'END_OF_FULL_SUBAGENT_RESULT',
  ].join('\n\n');
  const currentAnnounce = new AIMessage(currentAnnounceText);
  const input = buildOrchestratorRunInput([
    new HumanMessage('读取文件并运行 lint'),
    currentAnnounce,
  ]);
  setPinpetMeta(currentAnnounce, {
    lane: 'general',
    runId: input.runId,
    isAnnounce: true,
    completionReason: 'natural',
    delegationId: 'task-1',
    task: '读取文件并运行 lint',
  });
  input.runDelegations = [{
    id: 'task-1',
    lane: 'general',
    task: '读取文件并运行 lint',
    status: 'progress',
    resultPreview: currentAnnounceText,
  }];

  const result = await graph.invoke(input, {
    configurable: {
      thread_id: 'test-delegation-outcome',
      actor: testActor,
      capabilities: [capability('daily_post', '生成宠物日常动态。')],
      tools: [],
    },
  });

  // A new turn re-evaluates intent (discovery may run); the decision still sees
  // the prior announce as context via recent announces.
  assert.match(decisionInput, /文件读取完成，lint 已通过/);
  assert.match(decisionInput, /END_OF_FULL_SUBAGENT_RESULT/);
  // The dedicated answer node generates the final reply...
  assert.equal(result.messages.at(-1)?.content, 'answered');
  // ...and it receives the FULL (un-clipped) subagent announce from history,
  // so it can reproduce prior results faithfully instead of re-fabricating them.
  assert.match(answerInput, /END_OF_FULL_SUBAGENT_RESULT/);
  assert.ok(answerInput.includes('A'.repeat(1400)), 'answer node must see the un-clipped announce body');
});

test('answer node still sees compacted older results when the user asks to re-show them', async () => {
  let answerInput = '';
  const model = {
    invoke: async (messages: unknown[]) => {
      answerInput = (messages as Array<{ content?: unknown }>)
        .map((m) => String(m?.content ?? ''))
        .join('\n');
      return new AIMessage('answered');
    },
    bindTools: () => ({ invoke: async () => new AIMessage('') }),
    withStructuredOutput: () => ({ invoke: async () => ({ action: 'answer' }) }),
  } as unknown as AgentModels['act'];

  const graph = createOrchestratorGraph({
    models: { act: model, observe: model },
    actor: testActor,
  });
  // After compaction the older result survives only as the summary system message.
  const summary = new SystemMessage('压缩摘要：之前 explore 调研得到 SWE-bench Verified GPT-5.5 88.7%。COMPACTED_RESULT_MARKER');
  summary.name = CONTEXT_COMPACTION_MESSAGE_NAME;
  const input = buildOrchestratorRunInput([
    summary,
    new HumanMessage('把之前的调研结果再发一下'),
  ]);

  const result = await graph.invoke(input, {
    configurable: {
      thread_id: 'answer-sees-compaction-summary',
      actor: testActor,
      capabilities: [],
      tools: [],
    },
  });

  assert.equal(result.messages.at(-1)?.content, 'answered');
  // The answer node must see the compaction summary — otherwise it is blind to
  // the only surviving record of the older result and would re-fabricate it.
  assert.match(answerInput, /COMPACTED_RESULT_MARKER/);
});

test('delegation outcome answer lets the answer node reproduce the completed announce from full history', async () => {
  // The answer node sees the full conversation (including the completed announce)
  // and is responsible for reproducing it; the decision node no longer carries
  // any reply text. Here the answer mock echoes the announce it finds in history.
  const announceMarker = 'Vibe Coding 模型排行榜：1. Claude Sonnet 4；2. GPT-5；3. Gemini 2.5 Pro。';
  const routeModel = {
    invoke: async (messages: unknown[]) => {
      const joined = (messages as Array<{ content?: unknown }>)
        .map((m) => String(m?.content ?? ''))
        .join('\n');
      const echoed = joined.includes(announceMarker) ? announceMarker : '(announce missing from history)';
      return new AIMessage(echoed);
    },
    bindTools: () => ({
      invoke: async () => new AIMessage(''),
    }),
    withStructuredOutput: () => ({
      invoke: async () => ({ action: 'answer' }),
    }),
  } as unknown as AgentModels['act'];
  const graph = createOrchestratorGraph({
    models: { act: routeModel },
    actor: testActor,
  });
  const input = buildOrchestratorRunInput([
    new HumanMessage('帮我列一个目前 vibecoding 的模型排行榜。'),
  ]);
  const announceText = 'Vibe Coding 模型排行榜：1. Claude Sonnet 4；2. GPT-5；3. Gemini 2.5 Pro。';
  const announceMessage = new AIMessage(announceText);
  setPinpetMeta(announceMessage, {
    lane: 'general',
    runId: input.runId,
    isAnnounce: true,
    delegationId: 'task-1',
    task: '搜索并整理 vibecoding 模型排行榜。',
  });
  input.messages.push(announceMessage);
  input.runDelegations = [{
    id: 'task-1',
    lane: 'general',
    task: '搜索并整理 vibecoding 模型排行榜。',
    status: 'completed',
    resultPreview: announceText,
  }];

  const result = await graph.invoke(input, {
    configurable: {
      thread_id: 'delegation-outcome-leak-fallback',
      actor: testActor,
      capabilities: [],
      toolkits: [],
    },
  });
  const finalMessageText = String(result.messages.at(-1)?.content ?? '');

  assert.equal(finalMessageText, announceText);
});

test('answer decision emits no reply itself and routes to the dedicated answer node', async () => {
  let answerCalled = false;
  const model = {
    invoke: async () => {
      answerCalled = true;
      return new AIMessage('final reply from answer node');
    },
    bindTools: () => ({
      invoke: async () => new AIMessage(''),
    }),
    withStructuredOutput: () => ({
      // Decision returns only the action; no answer text is carried here.
      invoke: async () => ({ action: 'answer' }),
    }),
  } as unknown as AgentModels['act'];

  const graph = createOrchestratorGraph({
    models: { act: model, observe: model },
    actor: testActor,
  });
  const input = buildOrchestratorRunInput([new HumanMessage('你好')]);
  const state = await graph.invoke(input, {
    configurable: {
      thread_id: 'answer-routes-to-answer',
      actor: testActor,
      capabilities: [],
      tools: [],
    },
  });

  assert.equal(answerCalled, true, 'an answer decision must route to the answer node');
  const finalMessage = mainConversationMessages(state.messages).at(-1);
  assert.equal(finalMessage?.content, 'final reply from answer node');
  assert.match(readMessageCreatedAtUtc(finalMessage!) ?? '', /^\d{4}-\d{2}-\d{2}T.*Z$/);
});

test('limit-reached progress announce lets model choose the same capability delegation', async () => {
  let capabilityRunCount = 0;
  let decisionCallCount = 0;
  let decisionSystemPrompt = '';
  let decisionInput = '';
  const routeModel = {
    invoke: async () => new AIMessage('answered'),
    bindTools: () => ({
      // A new turn re-evaluates intent via capabilityDiscovery; with the
      // in-progress capability already seeded as a candidate, no search is needed.
      invoke: async () => new AIMessage(''),
    }),
    withStructuredOutput: () => ({
      invoke: async (messages: unknown[]) => {
        decisionCallCount += 1;
        if (decisionCallCount === 1) {
          assert.equal(messages.length, 2);
          const [systemMessage, inputMessage] = messages as Array<{
            _getType?: () => string;
            content?: unknown;
          }>;
          assert.equal(systemMessage?._getType?.(), 'system');
          assert.equal(inputMessage?._getType?.(), 'human');
          decisionSystemPrompt = String(systemMessage.content ?? '');
          decisionInput = String(inputMessage.content ?? '');
          return {
            action: 'delegate_capability.inspect_repo',
            task: '继续调查仓库 capability 注册链路。',
            context_summary: '上一轮因迭代上限停止，任务仍未完成。',
          };
        }
        return { action: 'answer' };
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
    maxRunIterations: 1,
    actor: testActor,
  });
  const input = buildOrchestratorRunInput([new HumanMessage('继续')]);
  const progressAnnounce = new AIMessage('(no matches)');
  setPinpetMeta(progressAnnounce, {
    lane: 'capability:inspect_repo',
    runId: input.runId,
    isAnnounce: true,
    completionReason: 'limit_reached',
    delegationId: 'task-limit',
    task: '调查仓库 capability 注册链路。',
  });
  input.messages.push(progressAnnounce);
  input.runDelegations = [{
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
  assert.equal(decisionCallCount, 1);
  // The active task context carries the continuation action, and the output
  // instruction mirrors the schema enum without expanding full target context.
  assert.match(decisionSystemPrompt, /当前候选中的 delegate_capability\.inspect_repo/);
  assert.doesNotMatch(decisionSystemPrompt, /业务 capability 候选/);
  assert.match(decisionInput, /<continuation_action>delegate_capability\.inspect_repo<\/continuation_action>/);
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
    invoke: async () => new AIMessage('answered'),
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
              action: 'answer',
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

  await graph.invoke(buildOrchestratorRunInput([new HumanMessage('inspect')]), {
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
        {
          name: 'artifact',
          description: 'artifact toolkit',
          exposure: { general: false },
          tools: [mockTool('artifact_read')],
        },
      ],
      forcedCapabilityNames: ['inspect_repo'],
    },
  });

  assert.deepEqual(runtimeToolkitNames, ['bash', 'browser', 'artifact']);
});

test('toolkit exposure can hide tools from the general lane', async () => {
  let routeCallCount = 0;
  let generalToolNames: string[] = [];
  const routeModel = {
    invoke: async () => new AIMessage('answered'),
    bindTools: () => ({
      invoke: async () => new AIMessage(''),
    }),
    withStructuredOutput: () => ({
      invoke: async () => {
        routeCallCount += 1;
        return routeCallCount === 1
          ? {
              action: 'delegate_general',
              task: 'inspect with tools',
              context_summary: null,
            }
          : {
              action: 'answer',
            };
      },
    }),
  } as unknown as AgentModels['act'];
  const subagentModel = new FakeToolCallingModel({ toolCalls: [[]] });
  const bindTools = subagentModel.bindTools.bind(subagentModel);
  (subagentModel as unknown as {
    bindTools: (tools: Array<{ name: string }>) => unknown;
  }).bindTools = (tools) => {
    generalToolNames = tools.map((toolItem) => toolItem.name);
    return bindTools(tools as never);
  };
  const graph = createOrchestratorGraph({
    models: {
      act: routeModel,
      observe: routeModel,
      subagent: subagentModel,
    },
    actor: testActor,
  });

  await graph.invoke(buildOrchestratorRunInput([new HumanMessage('inspect')]), {
    configurable: {
      thread_id: 'general-toolkit-exposure',
      actor: testActor,
      capabilities: [],
      toolkits: [
        {
          name: 'visible',
          description: 'visible toolkit',
          tools: [mockTool('visible_tool')],
        },
        {
          name: 'artifact',
          description: 'artifact toolkit',
          exposure: { general: false },
          tools: [mockTool('artifact_read')],
        },
      ],
    },
  });

  assert.deepEqual(generalToolNames, ['visible_tool']);
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

test('capability artifact refs recorded by subagent tools are merged into state', async () => {
  let routeCallCount = 0;
  const routeModel = {
    invoke: async () => new AIMessage('answered'),
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
              action: 'answer',
            };
      },
    }),
  } as unknown as AgentModels['act'];
  const artifactToolkit: AgentToolkit = {
    name: 'artifact',
    description: 'artifact recorder',
    tools: (ctx) => [
      tool(async () => {
        const ref = {
          id: 'artifact-1',
          threadId: ctx.threadId ?? 'missing-thread',
          capabilityId: ctx.capabilityId ?? 'missing-capability',
          delegationId: ctx.delegationId ?? 'missing-delegation',
          runId: ctx.runId ?? 'missing-turn',
          kind: 'report' as const,
          mimeType: 'text/markdown',
          uri: `capability-artifact://thread/${encodeURIComponent(ctx.threadId ?? '')}/artifact/1`,
          title: 'Issue exploration',
          preview: 'Checked the artifact handoff path.',
          sizeBytes: 19,
          createdAt: '2026-06-16T00:00:00.000Z',
          schema: { name: 'ExploreReport', version: 1 },
          metadata: { sourceCount: 2 },
        };
        await ctx.recordCapabilityArtifact?.(ref);
        return JSON.stringify(ref);
      }, {
        name: 'persist_report',
        description: 'persist report',
        schema: z.object({}),
      }),
    ],
  };
  const fixtureCapability: AgentCapability = {
    name: 'explore',
    description: 'Explore issue context.',
    createRuntime: () => ({
      uses: ['artifact'],
    }),
  };
  const graph = createOrchestratorGraph({
    models: {
      act: routeModel,
      observe: routeModel,
      subagent: new FakeToolCallingModel({
        toolCalls: [[{ id: 'call-persist', name: 'persist_report', args: {} }], []],
      }),
    },
    actor: testActor,
  });

  const state = await graph.invoke(buildOrchestratorRunInput([new HumanMessage('explore issue')]), {
    configurable: {
      thread_id: 'artifact-thread',
      actor: testActor,
      capabilities: [fixtureCapability],
      toolkits: [artifactToolkit],
      forcedCapabilityNames: ['explore'],
    },
  });

  assert.equal(state.sessionCapabilityArtifacts.length, 1);
  assert.equal(state.sessionCapabilityArtifacts[0]?.title, 'Issue exploration');
  assert.equal(state.sessionCapabilityArtifacts[0]?.threadId, 'artifact-thread');
  assert.equal(state.sessionCapabilityArtifacts[0]?.capabilityId, 'explore');
});

test('capability result artifacts are represented only as refs in state', async () => {
  let routeCallCount = 0;
  const routeModel = {
    invoke: async () => new AIMessage('answered'),
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
              action: 'answer',
            };
      },
    }),
  } as unknown as AgentModels['act'];
  const artifactToolkit: AgentToolkit = {
    name: 'artifact',
    description: 'artifact recorder',
    tools: (ctx) => [
      tool(async () => {
        const ref = {
          id: 'result-1',
          threadId: ctx.threadId ?? 'missing-thread',
          capabilityId: ctx.capabilityId ?? 'missing-capability',
          delegationId: ctx.delegationId ?? 'missing-delegation',
          runId: ctx.runId ?? 'missing-turn',
          kind: 'result' as const,
          mimeType: 'application/json',
          uri: `capability-artifact://thread/${encodeURIComponent(ctx.threadId ?? '')}/artifact/result-1`,
          title: 'Daily post result',
          preview: 'created post-1',
          sizeBytes: 39,
          createdAt: '2026-06-16T00:00:00.000Z',
          schema: { name: 'daily_post.result', version: 1 },
        };
        await ctx.recordCapabilityArtifact?.(ref);
        return JSON.stringify(ref);
      }, {
        name: 'persist_result',
        description: 'persist result',
        schema: z.object({}),
      }),
    ],
  };
  const fixtureCapability: AgentCapability = {
    name: 'daily_post',
    description: 'Create post.',
    createRuntime: () => ({
      uses: ['artifact'],
    }),
  };
  const graph = createOrchestratorGraph({
    models: {
      act: routeModel,
      observe: routeModel,
      subagent: new FakeToolCallingModel({
        toolCalls: [[{ id: 'call-persist', name: 'persist_result', args: {} }], []],
      }),
    },
    actor: testActor,
  });

  const state = await graph.invoke(buildOrchestratorRunInput([new HumanMessage('post')]), {
    configurable: {
      thread_id: 'result-artifact-thread',
      actor: testActor,
      capabilities: [fixtureCapability],
      toolkits: [artifactToolkit],
      forcedCapabilityNames: ['daily_post'],
    },
  });

  assert.equal(state.sessionCapabilityArtifacts[0]?.kind, 'result');
  assert.equal(state.sessionCapabilityArtifacts[0]?.schema?.name, 'daily_post.result');
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

test('global review policy full_access bypasses toolkit review prompts', async () => {
  let callCount = 0;
  let reviewCount = 0;
  const rawTool = tool(async () => {
    callCount += 1;
    return 'raw ok';
  }, {
    name: 'write_file',
    description: 'write file',
    schema: z.object({ path: z.string(), content: z.string() }),
  });
  const toolkits: AgentToolkit[] = [{
    name: 'local',
    description: 'local tools',
    tools: [rawTool],
    policy: {
      toolReview: {
        write_file: {
          request: () => {
            reviewCount += 1;
            return ReviewPolicies.localMutation().request({
              models: {} as AgentModels,
              actor: testActor,
              messages: [],
              toolkitName: 'local',
              toolName: 'write_file',
              input: { path: 'notes.md', content: 'hello' },
              reviewCapabilities: {
                humanReview: true,
                sessionAuthorization: false,
              },
            });
          },
        },
      },
    },
  }];

  const resources = await resolveToolkitResources(toolkits, ['local'], {
    models: {} as AgentModels,
    actor: testActor,
    messages: [],
    reviewCapabilities: {
      humanReview: false,
      sessionAuthorization: false,
    },
    globalReviewPolicy: { mode: 'full_access' },
  });

  const result = await resources.tools[0]?.invoke({ path: 'notes.md', content: 'hello' });
  assert.equal(result, 'raw ok');
  assert.equal(callCount, 1);
  assert.equal(reviewCount, 0);
});

test('global review policy auto_authorization authorizes safe reviewed tool calls', async () => {
  let callCount = 0;
  let autoReviewCount = 0;
  let autoReviewMessages: unknown;
  const runtimeEvents: unknown[] = [];
  const rawTool = tool(async ({ path }: { path: string }) => {
    callCount += 1;
    return `wrote ${path}`;
  }, {
    name: 'write_file',
    description: 'write file',
    schema: z.object({ path: z.string(), content: z.string() }),
  });
  const toolkits: AgentToolkit[] = [{
    name: 'local',
    description: 'local tools',
    tools: [rawTool],
    policy: {
      toolReview: {
        write_file: ReviewPolicies.localMutation(),
      },
    },
  }];
  const autoModel = {
    withStructuredOutput: () => ({
      invoke: async (messages: unknown) => {
        autoReviewCount += 1;
        autoReviewMessages = messages;
        return {
          decision: 'authorize',
          reason: 'Small scoped file write requested by the user.',
          confidence: 'high',
        };
      },
    }),
  } as unknown as AgentModels['act'];

  const resources = await resolveToolkitResources(toolkits, ['local'], {
    models: { act: autoModel },
    actor: testActor,
    messages: [new HumanMessage('write notes.md')],
    reviewCapabilities: {
      humanReview: false,
      sessionAuthorization: false,
    },
    globalReviewPolicy: { mode: 'auto_authorization' },
    emitRuntimeEvent: (event) => {
      runtimeEvents.push(event);
    },
  });

  const result = await resources.tools[0]?.invoke({ path: 'notes.md', content: 'hello' });
  assert.equal(result, 'wrote notes.md');
  assert.equal(callCount, 1);
  assert.equal(autoReviewCount, 1);
  const systemPrompt = (autoReviewMessages as Array<{ content?: unknown }>)[0]?.content;
  assert.match(String(systemPrompt), /JSON object/);
  assert.equal((runtimeEvents[0] as { name?: unknown } | undefined)?.name, 'global_review_policy_auto_authorized');
});

test('global review policy auto_authorization requires human authorization when unsure', async () => {
  let callCount = 0;
  const rawTool = tool(async () => {
    callCount += 1;
    return 'raw ok';
  }, {
    name: 'write_file',
    description: 'write file',
    schema: z.object({ path: z.string(), content: z.string() }),
  });
  const toolkits: AgentToolkit[] = [{
    name: 'local',
    description: 'local tools',
    tools: [rawTool],
    policy: {
      toolReview: {
        write_file: ReviewPolicies.localMutation(),
      },
    },
  }];
  const autoModel = {
    withStructuredOutput: () => ({
      invoke: async () => ({
        decision: 'require_authorization',
        reason: 'The write looks too broad.',
      }),
    }),
  } as unknown as AgentModels['act'];

  const resources = await resolveToolkitResources(toolkits, ['local'], {
    models: { act: autoModel },
    actor: testActor,
    messages: [new HumanMessage('rewrite the project')],
    reviewCapabilities: {
      humanReview: false,
      sessionAuthorization: false,
    },
    globalReviewPolicy: { mode: 'auto_authorization' },
  });

  const result = await resources.tools[0]?.invoke({ path: 'src/index.ts', content: 'new content' });
  const parsed = JSON.parse(String(result)) as { cancelled?: boolean; reason?: string };
  assert.equal(callCount, 0);
  assert.equal(parsed.cancelled, true);
  assert.match(parsed.reason ?? '', /too broad/);
});

test('global review policy custom resolver can authorize reviewed tool calls', async () => {
  let callCount = 0;
  let customReviewTitle: string | null = null;
  const rawTool = tool(async () => {
    callCount += 1;
    return 'raw ok';
  }, {
    name: 'write_file',
    description: 'write file',
    schema: z.object({ path: z.string(), content: z.string() }),
  });
  const toolkits: AgentToolkit[] = [{
    name: 'local',
    description: 'local tools',
    tools: [rawTool],
    policy: {
      toolReview: {
        write_file: ReviewPolicies.localMutation(),
      },
    },
  }];

  const resources = await resolveToolkitResources(toolkits, ['local'], {
    models: {} as AgentModels,
    actor: testActor,
    messages: [],
    reviewCapabilities: {
      humanReview: false,
      sessionAuthorization: false,
    },
    globalReviewPolicy: {
      mode: 'custom',
      resolve: (ctx) => {
        customReviewTitle = ctx.review.view.title ?? null;
        return { type: 'authorize', reason: 'custom policy allowed it' };
      },
    },
  });

  const result = await resources.tools[0]?.invoke({ path: 'notes.md', content: 'hello' });
  assert.equal(result, 'raw ok');
  assert.equal(callCount, 1);
  assert.equal(customReviewTitle, 'write_file');
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
    invoke: async () => new AIMessage('answered'),
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
              action: 'answer',
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
  const input = buildOrchestratorRunInput([new HumanMessage('run git status')]);

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
    sessionToolAuthorizations: Array<{ toolName: string; matcher: unknown; createdAt: string }>;
  };

  assert.equal(finalState.__interrupt__, undefined);
  assert.deepEqual(finalState.sessionToolAuthorizations.map(({ createdAt: _createdAt, ...item }) => item), [{
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
    invoke: async () => new AIMessage('answered'),
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
              action: 'answer',
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
    buildOrchestratorRunInput([new HumanMessage('run git status')]),
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
    runId: string;
  };

  assert.equal(finalState.__interrupt__, undefined);
  assert.equal(reviewCount, 2);
  assert.equal(runCount, 1);
  // After the resumed tool approval, the outcome decision finishes the task.
  // The result is handed off into the main queue and the lane transcript is
  // cleared, so continuation state is no longer inferred from a stale announce.
  const handoffCopy = mainConversationMessages(finalState.messages)
    .find((message) => message.content === 'ran git status');
  assert.ok(handoffCopy);
  const handoffSource = getMessageHandoffSource(handoffCopy);
  assert.equal(handoffSource?.handoffFrom, 'general');
  assert.ok(handoffSource?.delegationId);
  assert.equal(handoffSource?.task, 'run shell');
  assert.equal(readLatestAnnounce(finalState.messages, { runId: finalState.runId }), null);
});

test('buildSubagentHandoff copies the announce into main and wipes the whole delegation lane', () => {
  const userAsk = new HumanMessage('帮我查一下小红书动态');
  const intermediate = new AIMessage('正在抓取页面…');
  intermediate.id = 'm-intermediate';
  setPinpetMeta(intermediate, { lane: 'capability:explore', runId: 't1', delegationId: 'd1' });
  const announce = new AIMessage('已查到热门动态：A、B、C。FULL_ANNOUNCE_MARKER');
  announce.id = 'm-announce';
  setPinpetMeta(announce, { lane: 'capability:explore', runId: 't1', delegationId: 'd1', isAnnounce: true, task: '查动态' });
  // A different delegation in the same lane must be untouched.
  const otherDelegation = new AIMessage('另一个 delegation 的中间消息');
  otherDelegation.id = 'm-other';
  setPinpetMeta(otherDelegation, { lane: 'capability:explore', runId: 't1', delegationId: 'd2' });

  const messages = [userAsk, intermediate, announce, otherDelegation];
  const update = buildSubagentHandoff({ messages, lane: 'capability:explore', runId: 't1', delegationId: 'd1' });
  assert.ok(update, 'handoff update should be produced for a completed delegation');

  const removed = update.filter((m) => m instanceof RemoveMessage).map((m) => m.id);
  // d1's announce + intermediate are removed; d2 and the user message are not.
  assert.deepEqual(new Set(removed), new Set(['m-intermediate', 'm-announce']));

  const copies = update.filter((m) => !(m instanceof RemoveMessage));
  assert.equal(copies.length, 1);
  const copy = copies[0];
  // The copy carries the full announce text, lives in main (no lane), and keeps
  // only minimal provenance.
  assert.match(String(copy.content), /FULL_ANNOUNCE_MARKER/);
  assert.equal(getMessageLane(copy), null);
  assert.deepEqual(getMessageHandoffSource(copy), {
    handoffFrom: 'capability:explore',
    delegationId: 'd1',
    task: '查动态',
  });
});

test('buildSubagentHandoff carries announcement artifact refs', () => {
  const userAsk = new HumanMessage('请帮我做一次探索');
  const announce = new AIMessage('已整理好探索结果。');
  announce.id = 'm-announce-2';
  setPinpetMeta(announce, {
    lane: 'capability:explore',
    runId: 'run-1',
    delegationId: 'd-announce',
    isAnnounce: true,
    task: '探索任务',
  });
  const update = buildSubagentHandoff({
    messages: [userAsk, announce],
    lane: 'capability:explore',
    runId: 'run-1',
    delegationId: 'd-announce',
    artifactRefs: [
      {
        id: 'artifact-1',
        kind: 'report',
        mimeType: 'text/markdown',
        uri: 'capability-artifact://thread/t1/delegation/d-announce/artifact/artifact-1',
        title: 'Explore report',
        preview: '探索报告摘要',
        capabilityId: 'explore',
        delegationId: 'd-announce',
        runId: 'run-1',
      },
      {
        id: 'artifact-2',
        kind: 'result',
        mimeType: 'application/json',
        uri: 'capability-artifact://thread/t1/delegation/d-announce/artifact/artifact-2',
        capabilityId: 'explore',
        delegationId: 'd-announce',
        runId: 'run-1',
      },
    ],
  });
  assert.ok(update);
  const copy = update.find((message) => message instanceof AIMessage && message.id !== 'm-announce-2') as AIMessage;
  const content = String(copy.content);
  assert.match(content, /<artifacts>/);
  assert.match(content, /kind=report/);
  assert.match(content, /capability-artifact:\/\/thread\/t1\/delegation\/d-announce\/artifact\/artifact-1/);
  assert.match(content, /kind=result/);
  assert.match(content, /capability-artifact:\/\/thread\/t1\/delegation\/d-announce\/artifact\/artifact-2/);
  const source = getMessageHandoffSource(copy);
  assert.deepEqual(source, {
    handoffFrom: 'capability:explore',
    delegationId: 'd-announce',
    task: '探索任务',
  });
});

test('buildSubagentHandoff keeps lane messages when clearLane is disabled', () => {
  const humanAsk = new HumanMessage('继续处理一些文件');
  const intermediate = new AIMessage('准备处理中...');
  intermediate.id = 'm-mid';
  setPinpetMeta(intermediate, { lane: 'general', runId: 'run-5', delegationId: 'd-keep' });
  const announce = new AIMessage('已完成部分，继续留痕。');
  announce.id = 'm-announce-keep';
  setPinpetMeta(announce, {
    lane: 'general',
    runId: 'run-5',
    delegationId: 'd-keep',
    isAnnounce: true,
    task: '增量处理',
  });

  const update = buildSubagentHandoff({
    messages: [humanAsk, intermediate, announce],
    lane: 'general',
    runId: 'run-5',
    delegationId: 'd-keep',
    clearLane: false,
  });
  assert.ok(update);
  const removed = update.filter((m) => m instanceof RemoveMessage);
  assert.equal(removed.length, 0);
  const copy = update.find((m) => m instanceof AIMessage && m.id !== 'm-announce-keep') as AIMessage | undefined;
  assert.ok(copy);
  assert.match(String(copy.content), /已完成部分，继续留痕。/);
  const source = getMessageHandoffSource(copy);
  assert.deepEqual(source, {
    handoffFrom: 'general',
    delegationId: 'd-keep',
    task: '增量处理',
  });
});

test('readRecentAnnounces strips handoff artifact footer and preserves artifact refs', () => {
  const userAsk = new HumanMessage('请帮我做一次探索');
  const announce = new AIMessage('探索已完成，产出三条关键结论。');
  announce.id = 'm-announce-3';
  setPinpetMeta(announce, {
    lane: 'capability:explore',
    runId: 'run-2',
    delegationId: 'd-announce-2',
    isAnnounce: true,
    task: '探索任务',
  });

  const update = buildSubagentHandoff({
    messages: [userAsk, announce],
    lane: 'capability:explore',
    runId: 'run-2',
    delegationId: 'd-announce-2',
    artifactRefs: [
      {
        id: 'artifact-1',
        kind: 'report',
        mimeType: 'text/markdown',
        uri: 'capability-artifact://thread/t1/delegation/d-announce-2/artifact/artifact-1',
        title: 'Explore report',
        preview: '这是一个用于验证 footer 解析的短 preview。',
        capabilityId: 'explore',
        delegationId: 'd-announce-2',
        runId: 'run-2',
      },
      {
        id: 'artifact-2',
        kind: 'result',
        mimeType: 'application/json',
        uri: 'capability-artifact://thread/t1/delegation/d-announce-2/artifact/artifact-2',
        capabilityId: 'explore',
        delegationId: 'd-announce-2',
        runId: 'run-2',
      },
    ],
  });

  assert.ok(update);
  const copy = update.find((message) => message instanceof AIMessage && message.id !== 'm-announce-3') as AIMessage;
  const announces = readRecentAnnounces([copy]);
  assert.equal(announces.length, 1);
  const announcement = announces[0];
  assert.equal(announcement.text, '探索已完成，产出三条关键结论。');
  assert.deepEqual(announcement.artifactRefs?.length, 2);
  assert.equal(announcement.artifactRefs?.[0]?.kind, 'report');
  assert.match(announcement.artifactRefs?.[0]?.uri ?? '', /artifact-1$/);

  const copyText = String(copy.content);
  assert.match(copyText, /<artifacts>/);
  assert.match(copyText, /artifact-1/);
});

test('buildSubagentHandoff clips and bounds handoff artifact footer refs', () => {
  const userAsk = new HumanMessage('请帮我做一次大规模探索');
  const announce = new AIMessage('探索完成，已产出大量 evidence。');
  announce.id = 'm-announce-4';
  setPinpetMeta(announce, {
    lane: 'capability:explore',
    runId: 'run-3',
    delegationId: 'd-announce-3',
    isAnnounce: true,
    task: '全量探索',
  });

  const artifactRefs = Array.from({ length: 9 }).map((_, index) => ({
    id: `artifact-${index + 1}`,
    kind: index === 0 ? 'file' as const : index === 1 ? 'result' as const : 'report' as const,
    mimeType: 'text/markdown',
    uri: `capability-artifact://thread/t1/delegation/d-announce-3/artifact/${'x'.repeat(250)}-${index + 1}`,
    title: `这是一个很长的标题，长度会被裁剪 ${'标题'.repeat(40)}-${index + 1}`,
    preview: `这是一个很长的 preview，会被裁剪，避免 prompt 爆炸。${'文本 '.repeat(120)}-${index + 1}`,
    capabilityId: 'explore',
    delegationId: 'd-announce-3',
    runId: 'run-3',
  }));

  const update = buildSubagentHandoff({
    messages: [userAsk, announce],
    lane: 'capability:explore',
    runId: 'run-3',
    delegationId: 'd-announce-3',
    artifactRefs,
  });

  assert.ok(update);
  const copy = update.find((message) => message instanceof AIMessage && message.id !== 'm-announce-4') as AIMessage;
  const announces = readRecentAnnounces([copy]);
  const announcedRefs = announces[0]?.artifactRefs ?? [];
  assert.equal(announcedRefs.length, 5);
  assert.ok(announcedRefs.every((ref) => ref.uri.includes('…') || ref.title?.includes('…') || ref.preview?.includes('…')));
});

test('readRecentAnnounces parses handoff artifact footer values with spaces and equals', () => {
  const handoffCopy = new AIMessage(
    [
      '探索完成，给你最终结论。',
      '<artifacts>',
      '- kind=report',
      '  capability=explore',
      '  uri=capability-artifact://thread/t4/delegation/d-space/artifact/result?query=a=b&flag=1',
      '  title=含 空格 与 等号 a=b 的标题',
      '  preview=preview 里包含 空格 与 a=b 等号，仍应完整保留。',
      '</artifacts>',
    ].join('\n'),
  );
  setPinpetMeta(handoffCopy, {
    handoffFrom: 'capability:explore',
    delegationId: 'd-space',
    task: '空间+等号场景',
  });

  const recalls = readRecentAnnounces([handoffCopy]);
  assert.equal(recalls.length, 1);
  const firstArtifact = recalls[0]?.artifactRefs?.[0];
  assert.equal(firstArtifact?.uri, 'capability-artifact://thread/t4/delegation/d-space/artifact/result?query=a=b&flag=1');
  assert.equal(firstArtifact?.title, '含 空格 与 等号 a=b 的标题');
  assert.equal(firstArtifact?.preview, 'preview 里包含 空格 与 a=b 等号，仍应完整保留。');
  assert.equal(recalls[0]?.text, '探索完成，给你最终结论。');
});

test('buildSubagentHandoff returns null when the delegation has no announce text', () => {
  const intermediate = new AIMessage('只有中间步骤，没有结论');
  intermediate.id = 'm1';
  setPinpetMeta(intermediate, { lane: 'general', runId: 't1', delegationId: 'd1' });
  const update = buildSubagentHandoff({
    messages: [new HumanMessage('做点事'), intermediate],
    lane: 'general',
    runId: 't1',
    delegationId: 'd1',
  });
  assert.equal(update, null);
});

test('different-lane outcome decision keeps active delegation when handoff cannot be built', async () => {
  let toolRunCount = 0;
  const rawTool = tool(async () => {
    toolRunCount += 1;
    return 'ran';
  }, {
    name: 'run_shell',
    description: 'run shell',
    schema: z.object({}),
  });
  const routeModel = {
    invoke: async () => new AIMessage('answered'),
    bindTools: () => ({
      invoke: async () => new AIMessage(''),
    }),
    withStructuredOutput: () => ({
      invoke: async () => ({
        action: 'delegate_general',
        task: '改用 general 继续调查。',
        context_summary: '尝试切换执行器。',
      }),
    }),
  } as unknown as AgentModels['act'];
  const graph = createOrchestratorGraph({
    models: {
      act: routeModel,
      subagent: new FakeToolCallingModel({ toolCalls: [[]] }),
    },
    actor: testActor,
  });
  const activeDelegation: TaskActiveDelegation = {
    id: 'active-1',
    lane: 'capability:explore',
    task: '当前 explore 任务',
    contextSummary: '已有任务仍待判断。',
    transcriptRunId: 'run-active',
    status: 'awaiting_decision',
    resultPreview: null,
  };
  const input = {
    ...buildOrchestratorRunInput([
      new HumanMessage('继续'),
      // No announce message for active-1: buildSubagentHandoff must return null.
      new AIMessage('只有中间步骤，没有可交接结果。'),
    ]),
    taskActiveDelegation: activeDelegation,
  };
  input.runDelegations = [{
    id: 'active-1',
    lane: 'capability:explore',
    task: '当前 explore 任务',
    status: 'progress',
    resultPreview: null,
  }];

  const state = await graph.invoke(input, {
    configurable: {
      thread_id: 'different-lane-replacement-blocked',
      actor: testActor,
      capabilities: [capability('explore', '探索 capability。')],
      toolkits: [{
        name: 'local',
        description: 'local tools',
        tools: [rawTool],
      }],
    },
  }) as {
    messages: Array<AIMessage | HumanMessage>;
    runPendingDelegation: unknown;
    taskActiveDelegation: TaskActiveDelegation | null;
    runDelegations: RunDelegation[];
  };

  assert.equal(toolRunCount, 0);
  assert.equal(state.runPendingDelegation, null);
  assert.equal(state.taskActiveDelegation?.id, 'active-1');
  assert.equal(state.taskActiveDelegation?.lane, 'capability:explore');
  assert.deepEqual(state.runDelegations.map((item) => item.id), ['active-1']);
  assert.match(String(mainConversationMessages(state.messages).at(-1)?.content ?? ''), /暂不能切换到新的执行器/);
});

test('delegation outcome continue decision can re-enter main and finalize handoff', async () => {
  const announceText = '已完成第一批抓取，接下来继续。';
  let routeCallCount = 0;
  const routeModel = {
    invoke: async () => new AIMessage(''),
    bindTools: () => ({
      invoke: async () => new AIMessage(''),
    }),
    withStructuredOutput: () => ({
      invoke: async () => {
        routeCallCount += 1;
        return routeCallCount === 1
          ? {
              action: 'delegate_general',
              task: '继续处理剩余工作。',
              context_summary: '保留当前发现并往下推进。',
            }
          : {
              action: 'answer',
            };
      },
    }),
  } as unknown as AgentModels['act'];
  const graph = createOrchestratorGraph({
    models: {
      act: routeModel,
      observe: routeModel,
      subagent: new FakeToolCallingModel({ toolCalls: [[]] }),
    },
    actor: testActor,
  });
  const activeDelegation: TaskActiveDelegation = {
    id: 'active-continue',
    lane: 'general',
    task: '批量梳理仓库问题',
    contextSummary: '已完成部分。',
    transcriptRunId: 'run-continue',
    status: 'awaiting_decision',
    resultPreview: '已完成第一批抓取，剩余待查。',
  };
  const inputBase = buildOrchestratorRunInput([new HumanMessage('继续处理仓库')]);
  activeDelegation.transcriptRunId = inputBase.runId;
  const input = {
    ...inputBase,
    taskActiveDelegation: activeDelegation,
  };
  input.runDelegations = [{
    id: activeDelegation.id,
    lane: activeDelegation.lane,
    task: activeDelegation.task,
    status: 'progress',
    resultPreview: activeDelegation.resultPreview,
  }];

  const previousAnnounce = new AIMessage(announceText);
  previousAnnounce.id = 'm-prev-announce';
  setPinpetMeta(previousAnnounce, {
    lane: 'general',
    runId: input.runId,
    delegationId: activeDelegation.id,
    isAnnounce: true,
    completionReason: 'natural',
    task: activeDelegation.task,
  });
  input.messages.push(previousAnnounce);

  const state = await graph.invoke(input, {
    configurable: {
      thread_id: 'delegation-continue-copy-preserve-lane',
      actor: testActor,
      capabilities: [],
      toolkits: [{
        name: 'local',
        description: 'local tools',
        tools: [mockTool('run_shell')],
      }],
    },
  }) as OrchestratorStateType;

  const handoffSource = mainConversationMessages(state.messages)
    .map((message) => getMessageHandoffSource(message))
    .find((source) => source?.delegationId === activeDelegation.id);
  assert.ok(handoffSource);
  assert.equal(handoffSource.handoffFrom, 'general');
  assert.equal(handoffSource.task, activeDelegation.task);
  // Final handoff on answer should clear lane transcript for finished continuation.
  assert.equal(laneMessages(state.messages, 'general', input.runId, activeDelegation.id)
    .filter((message) => getMessageIsAnnounce(message)).length === 0, true);
});

test('delegation outcome continuation path rechecks run iteration guard before next decision', async () => {
  let routeCallCount = 0;
  const routeModel = {
    invoke: async () => new AIMessage(''),
    bindTools: () => ({
      invoke: async () => new AIMessage(''),
    }),
    withStructuredOutput: () => ({
      invoke: async () => {
        routeCallCount += 1;
        return {
          action: routeCallCount === 1 ? 'delegate_general' : 'answer',
          task: '继续执行下一段。',
          context_summary: '已经执行了一段进度。',
        };
      },
    }),
  } as unknown as AgentModels['act'];
  const graph = createOrchestratorGraph({
    models: {
      act: routeModel,
      observe: routeModel,
      subagent: new FakeListChatModel({ responses: ['已完成一段子任务。'], sleep: 0 }),
    },
    actor: testActor,
  });

  const activeDelegation: TaskActiveDelegation = {
    id: 'active-limit-inline',
    lane: 'general',
    task: '执行长流程任务',
    contextSummary: '持续进行。',
    transcriptRunId: 'run-continue-limit',
    status: 'awaiting_decision',
    resultPreview: '进度已完成前段。',
  };
  const inputBase = buildOrchestratorRunInput([new HumanMessage('继续执行任务')]);
  activeDelegation.transcriptRunId = inputBase.runId;
  const input = {
    ...inputBase,
    taskActiveDelegation: activeDelegation,
    runDelegations: [{
      id: activeDelegation.id,
      lane: activeDelegation.lane,
      task: activeDelegation.task,
      status: 'progress',
      resultPreview: activeDelegation.resultPreview,
    }] as RunDelegation[],
  };

  const announce = new AIMessage('进度已完成前段。');
  announce.id = 'm-limit-announce';
  setPinpetMeta(announce, {
    lane: 'general',
    runId: input.runId,
    delegationId: activeDelegation.id,
    isAnnounce: true,
    completionReason: 'natural',
    task: activeDelegation.task,
  });
  input.messages.push(announce);

  const state = await graph.invoke(input, {
    configurable: {
      thread_id: 'delegation-outcome-to-iteration-guard',
      actor: testActor,
      capabilities: [],
      maxRunIterations: 1,
      toolkits: [{
        name: 'local',
        description: 'local tools',
        tools: [mockTool('run_shell')],
      }],
    },
  }) as OrchestratorStateType;

  assert.equal(routeCallCount, 1);
  assert.equal(state.taskActiveDelegation?.id, activeDelegation.id);
  assert.equal(state.runIterationCount, 0);
  const finalText = String(state.messages.at(-1)?.content ?? '');
  assert.match(finalText, /主流程循环已达到上限/);
});

test('delegation_outcome does not append duplicate handoff copies for unchanged announce', async () => {
  let routeCallCount = 0;
  const routeModel = {
    invoke: async () => new AIMessage(''),
    bindTools: () => ({
      invoke: async () => new AIMessage(''),
    }),
    withStructuredOutput: () => ({
      invoke: async () => {
        routeCallCount += 1;
        if (routeCallCount === 1 || routeCallCount === 2) {
          return {
            action: 'delegate_general',
            task: '继续执行后续步骤。',
            context_summary: '任务仍未完成。',
          };
        }
        return { action: 'answer' };
      },
    }),
  } as unknown as AgentModels['act'];
  const graph = createOrchestratorGraph({
    models: {
      act: routeModel,
      observe: routeModel,
      subagent: new FakeListChatModel({
        responses: ['进度更新：已完成一部分，继续保留。', '进度更新：已完成一部分，继续保留。'],
        sleep: 0,
      }),
    },
    actor: testActor,
  });

  const activeDelegation: TaskActiveDelegation = {
    id: 'active-dup-copy',
    lane: 'general',
    task: '处理大型清单',
    contextSummary: '尚未完成。',
    transcriptRunId: 'run-dup-copy',
    status: 'awaiting_decision',
    resultPreview: '进度更新：已完成一部分，继续保留。',
  };
  const inputBase = buildOrchestratorRunInput([new HumanMessage('继续清单处理')]);
  activeDelegation.transcriptRunId = inputBase.runId;
  const input = {
    ...inputBase,
    taskActiveDelegation: activeDelegation,
    runDelegations: [{
      id: activeDelegation.id,
      lane: activeDelegation.lane,
      task: activeDelegation.task,
      status: 'progress',
      resultPreview: activeDelegation.resultPreview,
    }] as RunDelegation[],
  };
  const initialAnnounce = new AIMessage('进度更新：已完成一部分，继续保留。');
  initialAnnounce.id = 'm-dup-copy';
  setPinpetMeta(initialAnnounce, {
    lane: 'general',
    runId: input.runId,
    delegationId: activeDelegation.id,
    isAnnounce: true,
    completionReason: 'natural',
    task: activeDelegation.task,
  });
  input.messages.push(initialAnnounce);

  const state = await graph.invoke(input, {
    configurable: {
      thread_id: 'delegation-outcome-no-duplicate-handoff',
      actor: testActor,
      capabilities: [],
      maxRunIterations: 10,
      toolkits: [{
        name: 'local',
        description: 'local tools',
        tools: [mockTool('run_shell')],
      }],
    },
  }) as OrchestratorStateType;

  assert.equal(routeCallCount, 3);
  const handoffCopies = mainConversationMessages(state.messages)
    .filter((message) => {
      const source = getMessageHandoffSource(message);
      return source?.delegationId === activeDelegation.id;
    });
  assert.equal(handoffCopies.length, 1);
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
  // The deliverable message is marked as the announce (neutral, no verdict).
  assert.equal(getMessageIsAnnounce(messages[1]), true);
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
    text: '已查到热门动态。',
  });
});

test('lane tagging marks the deliverable as the announce regardless of stop reason', () => {
  const messages = [
    new HumanMessage('读取文件并运行 lint'),
    new AIMessage('文件读取完成，lint 还没跑。'),
  ];

  // limit_reached is just a stop reason now; the deliverable is still marked as
  // the announce (no completed/progress verdict at tag time).
  tagNewLaneMessages(messages, 1, 'general', 'turn-1', 'limit_reached', {
    delegationId: 'task-2',
    task: '读取文件并运行 lint',
  });

  assert.equal(getMessageIsAnnounce(messages[1]), true);
  assert.deepEqual(readLatestAnnounce(messages, { delegationId: 'task-2' }), {
    lane: 'general',
    delegationId: 'task-2',
    task: '读取文件并运行 lint',
    text: '文件读取完成，lint 还没跑。',
  });
});

test('delegation outcome does not handoff a limit_reached announce', async () => {
  const routeModel = {
    invoke: async () => new AIMessage('answered'),
    bindTools: () => ({
      invoke: async () => new AIMessage(''),
    }),
    withStructuredOutput: () => ({
      invoke: async () => ({ action: 'answer' }),
    }),
  } as unknown as AgentModels['act'];
  const graph = createOrchestratorGraph({
    models: {
      act: routeModel,
      observe: routeModel,
    },
    actor: testActor,
  });
  const baseInput = buildOrchestratorRunInput([new HumanMessage('继续')]);

  const activeDelegation: TaskActiveDelegation = {
    id: 'limit-active',
    lane: 'general',
    task: '继续探查 repo',
    contextSummary: null,
    transcriptRunId: baseInput.runId,
    status: 'awaiting_decision',
    resultPreview: '上一轮还没结束。',
  };
  const input = {
    ...baseInput,
    taskActiveDelegation: activeDelegation,
    runDelegations: [{
      id: activeDelegation.id,
      lane: activeDelegation.lane,
      task: activeDelegation.task,
      status: 'progress' as const,
      resultPreview: activeDelegation.resultPreview,
    }],
  };
  const partialAnnounce = new AIMessage('已跑到一半，继续需要更多时间。');
  setPinpetMeta(partialAnnounce, {
    lane: 'general',
    runId: input.runId,
    delegationId: activeDelegation.id,
    isAnnounce: true,
    completionReason: 'limit_reached',
    task: activeDelegation.task,
  });

  input.messages.push(partialAnnounce);

  const state = await graph.invoke(input, {
    configurable: {
      thread_id: 'limit-announce-no-handoff',
      actor: testActor,
      capabilities: [],
      toolkits: [{
        name: 'local',
        description: 'local tools',
        tools: [mockTool('run_shell')],
      }],
  } }) as OrchestratorStateType;

  const handoffMessages = mainConversationMessages(state.messages)
    .filter((message) => getMessageHandoffSource(message)?.handoffFrom);
  assert.equal(handoffMessages.length, 0);
  assert.equal(state.taskActiveDelegation?.id, activeDelegation.id);
  assert.equal(state.taskActiveDelegation?.status, 'awaiting_decision');
  assert.equal(state.runDelegations.find((item) => item.id === activeDelegation.id)?.status, 'progress');
  assert.equal(state.messages.filter((message) => getMessageLane(message) === 'general').length > 0, true);
});

test('delegation outcome uses a unified run-iteration guard before invoking decision', async () => {
  const routeModel = {
    invoke: async () => new AIMessage('answered'),
    bindTools: () => ({
      invoke: async () => new AIMessage(''),
    }),
    withStructuredOutput: () => ({
      invoke: async () => {
        assert.fail('delegation decision should not run after run-iteration limit');
      },
    }),
  } as unknown as AgentModels['act'];

  const graph = createOrchestratorGraph({
    models: {
      act: routeModel,
      observe: routeModel,
    },
    actor: testActor,
    maxRunIterations: 2,
  });
  const baseInput = buildOrchestratorRunInput([new HumanMessage('继续')]);
  const input = {
    ...baseInput,
    taskActiveDelegation: null as TaskActiveDelegation | null,
    runDelegations: [] as RunDelegation[],
  };
  input.runIterationCount = 2;
  const activeDelegation: TaskActiveDelegation = {
    id: 'limit-iter',
    lane: 'general',
    task: '持续执行大规模迁移',
    contextSummary: '最近卡住',
    transcriptRunId: baseInput.runId,
    status: 'awaiting_decision',
    resultPreview: '处理到一半。',
  };
  const partialAnnounce = new AIMessage('继续迁移，已完成 50%。');
  setPinpetMeta(partialAnnounce, {
    lane: 'general',
    runId: input.runId,
    delegationId: activeDelegation.id,
    isAnnounce: true,
    completionReason: 'natural',
    task: activeDelegation.task,
  });

  input.messages.push(partialAnnounce);
  input.taskActiveDelegation = activeDelegation;
  input.runDelegations = [{
    id: activeDelegation.id,
    lane: activeDelegation.lane,
    task: activeDelegation.task,
    status: 'progress' as const,
    resultPreview: activeDelegation.resultPreview,
  }];

  const state = await graph.invoke(input, {
    configurable: {
      thread_id: 'unified-run-iteration-limit',
      actor: testActor,
      capabilities: [],
      toolkits: [{
        name: 'local',
        description: 'local tools',
        tools: [mockTool('run_shell')],
      }],
    },
  }) as OrchestratorStateType;

  assert.equal(state.messages.at(-1)?.content?.toString().includes('主流程循环已达到上限'), true);
  assert.equal(state.runIterationCount, 0);
  assert.equal(state.taskActiveDelegation?.id, activeDelegation.id);
});

test('handoff copies the announce into main and wipes the lane transcript', () => {
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
  const stateWithLane = messagesStateReducer([human], tagged);

  const handoff = buildSubagentHandoff({
    messages: stateWithLane,
    lane: 'general',
    runId: 'turn-1',
    delegationId: 'task-complete',
  });
  assert.ok(handoff);
  const stateMessages = messagesStateReducer(stateWithLane, handoff);

  // The lane transcript is gone; only the user message and a main-queue copy of
  // the announce remain.
  assert.deepEqual(stateMessages.map((message) => message.content), [
    '检查项目并汇报',
    '检查完成，测试脚本是 node --test。',
  ]);
  // The copy is a first-class main message (no lane) with handoff provenance.
  assert.equal(getMessageLane(stateMessages[1]), null);
  assert.deepEqual(getMessageHandoffSource(stateMessages[1]), {
    handoffFrom: 'general',
    delegationId: 'task-complete',
    task: '检查项目并汇报',
  });
  // No lane-tagged messages for this delegation remain.
  assert.equal(stateMessages.filter((m) => getMessageLane(m) === 'general').length, 0);

  // readRecentAnnounces must still recall the announce after handoff — it now
  // lives in the main queue as a handed-off copy, not in the (wiped) lane.
  const recalled = readRecentAnnounces(stateMessages);
  assert.equal(recalled.length, 1);
  assert.deepEqual(recalled[0], {
    lane: 'general',
    delegationId: 'task-complete',
    task: '检查项目并汇报',
    text: '检查完成，测试脚本是 node --test。',
  });
});

test('handoff after a resumed delegation wipes the whole delegation lane including old progress', () => {
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
  // First (interrupted) run keeps its whole lane in place — no handoff yet.
  const previousUpdate = tagNewLaneMessages(previousRun, 1, 'general', 'turn-1', 'limit_reached', {
    delegationId: 'task-resume',
    task: '处理所有分片',
  });
  const stateWithProgress = messagesStateReducer([human], previousUpdate);
  assert.equal(laneMessages(stateWithProgress, 'general', 'turn-1', 'task-resume').length, 4);

  // Continuation (same delegationId) completes naturally.
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
  const stateBeforeHandoff = messagesStateReducer(stateWithProgress, taggedContinuation);

  const handoff = buildSubagentHandoff({
    messages: stateBeforeHandoff,
    lane: 'general',
    runId: 'turn-1',
    delegationId: 'task-resume',
  });
  assert.ok(handoff);
  const finalState = messagesStateReducer(stateBeforeHandoff, handoff);

  // The entire delegation lane (old progress + continuation transcript) is gone;
  // only the user message and the main-queue copy of the final announce remain.
  assert.equal(finalState.filter((m) => getMessageLane(m) === 'general').length, 0);
  assert.deepEqual(mainConversationMessages(finalState).map((m) => m.content), [
    '处理所有分片',
    '全部分片已处理完成，共 120 条。',
  ]);
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
  assert.equal(getMessageIsAnnounce(toolResult), false);
  assert.equal(readLatestAnnounce(stateMessages, { delegationId: 'task-3' }), null);
});

test('lane messages sanitize legacy checkpoint history with dangling tool calls', () => {
  const human = new HumanMessage('继续归档');
  const danglingToolCall = new AIMessage({
    content: '准备移动。',
    tool_calls: [{ id: 'call-legacy', name: 'move_path', args: { source: 'a', destination: 'b' } }],
  });
  setPinpetMeta(danglingToolCall, { lane: 'general', runId: 'turn-1', delegationId: 'task-legacy' });

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
  setPinpetMeta(legacyLaneMessage, { lane: 'general', runId: 'turn-1' });

  assert.deepEqual(laneMessages([human, legacyLaneMessage], 'general', 'turn-1', 'task-1').map((message) => message.content), [
    '继续',
  ]);
});

test('delegation helpers reuse progress delegation and update result', () => {
  const delegations: RunDelegation[] = [
    {
      id: 'task-1',
      lane: 'general',
      task: '读取文件',
      status: 'progress',
      resultPreview: '已读取部分文件',
    },
  ];

  const reused = reuseOrAppendRunDelegation(delegations, {
    id: 'task-2',
    lane: 'general',
    task: '继续读取文件并运行 lint',
    contextSummary: '继续完成用户当前请求。',
  });

  assert.equal(reused.runPendingDelegation?.id, 'task-1');
  assert.equal(reused.runPendingDelegation?.task, '继续读取文件并运行 lint');
  assert.equal(reused.runDelegations.length, 1);
  assert.equal(reused.runDelegations[0].task, '继续读取文件并运行 lint');
  assert.equal(reused.runDelegations[0].status, 'pending');

  const completed = updateRunDelegationResult(reused.runDelegations, 'task-1', {
    status: 'completed',
    resultPreview: '任务完成',
  });
  assert.equal(completed[0].status, 'completed');
  assert.equal(completed[0].resultPreview, '任务完成');
});
