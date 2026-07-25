// @ts-nocheck — eval script, types from langsmith barrel are incomplete
/**
 * LangSmith evaluation: orchestrator flow with mocked subagent.
 *
 * This runs the real orchestrator graph through route -> subagent -> route.
 * The route model is the configured real model; only the subagent model is a
 * deterministic fake chat model that returns the example's subagent_response.
 *
 * Run:
 *   LLM_BASE_URL=... LLM_MODEL=... DECISION_STRUCTURED_OUTPUT_METHOD=jsonMode \
 *     npx tsx evals/orchestrator-flow.mock-subagent.eval.ts
 */
import { evaluate } from 'langsmith/evaluation';
import { Client } from 'langsmith';
import { ChatOpenAI } from '@langchain/openai';
import { AIMessage, HumanMessage } from '@langchain/core/messages';
import { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { Command, MemorySaver } from '@langchain/langgraph';
import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { homedir } from 'node:os';
import {
  buildOrchestratorTurnInput,
  createOrchestratorGraph,
  type OrchestrationDecisionStructuredOutputConfig,
} from '../src/agent/createAgentRuntime';
import type { AgentActor, AgentModels } from '../src/types/agent';
import {
  defineInstructionDocument,
  type AgentCapability,
} from '../src/types/capability';
import { defineToolkit } from '../src/types/toolkit';
import { inferStructuredOutputMethod } from '../src/utils/structuredOutput';
import { readLatestAnnounce } from '../src/agent/orchestrator/messageLanes';
import {
  readRunDelegationSummaries,
  readTaskActiveDelegation,
  routeModeFromResult,
} from './orchestratorStateReaders';

const DATASET_NAME = 'orchestrator-flow-mock-subagent';

const examples = [
  {
    name: 'file-read-flow-finishes-after-general',
    inputs: {
      user_message: '帮我看一下 src/index.ts 的内容',
      subagent_response: '已读取 src/index.ts，文件导出了 createApp 和 startServer 两个入口函数。',
    },
    outputs: {
      expected_route: 'answer',
      expected_mode: 'answer',
      expected_phase: 'after_subagent',
      expected_latest_announce_kind: 'completed',
      reason: 'Route should delegate file reading once, consume completed announce, then answer.',
    },
  },
  {
    name: 'browser-flow-finishes-after-browser-capability',
    inputs: {
      user_message: '打开小红书探索页看看今天有什么热门内容',
      capability_pack: 'browser',
      subagent_response: '已打开小红书探索页并提取到热门内容：宠物日常、春季出游、家居收纳、穿搭分享。可以基于这些方向继续选题。',
    },
    outputs: {
      expected_route: 'answer',
      expected_mode: 'answer',
      expected_phase: 'after_subagent',
      expected_latest_announce_kind: 'completed',
      expected_latest_announce_lane: 'capability:browser',
      reason: 'A completed browser announce should be enough for route to answer, not re-delegate.',
    },
  },
  {
    name: 'browser-flow-finishes-after-general-with-daily-post-candidate',
    inputs: {
      user_message: '你好，再来帮我查一下小红书上今天有什么动态',
      capability_pack: 'daily_post_only',
      subagent_response: '已打开小红书发现页并提取到今日热门动态：科技 AI 内容、穿搭分享、春季出游和家居收纳等方向。',
    },
    outputs: {
      expected_route: 'answer',
      expected_mode: 'answer',
      expected_phase: 'after_subagent',
      expected_latest_announce_kind: 'completed',
      reason: 'A completed lookup should answer even if capability discovery found a daily_post candidate from keyword overlap.',
    },
  },
  {
    name: 'multi-action-flow-finishes-when-subagent-completes-all',
    inputs: {
      user_message: '帮我把当前项目里的所有 var 声明改成 const，并运行 lint 检查',
      subagent_response: '已将所有 var 声明改成 const，并运行 lint 检查；lint 通过，退出码 0。',
    },
    outputs: {
      expected_route: 'answer',
      expected_mode: 'answer',
      expected_phase: 'after_subagent',
      expected_latest_announce_kind: 'completed',
      reason: 'When the subagent completed both requested actions, route should answer.',
    },
  },
  // Known issue: the current orchestrator reuses the same delegation id for a
  // same-lane follow-up too aggressively. This keeps the multi-task boundary
  // problem visible until the next multi-task delegation redesign decides when
  // to continue a delegation vs. start a clean one.
  {
    name: 'two-tasks-second-subagent-starts-clean',
    inputs: {
      user_message: '先帮我读取 src/index.ts 的内容，读完以后再单独运行 npm run lint 检查一下',
      subagent_responses: [
        '已读取 src/index.ts：文件导出了 createApp 和 startServer 两个入口函数。lint 检查还没有运行。',
        '已运行 npm run lint，检查通过，退出码 0。',
      ],
    },
    outputs: {
      expected_route: 'answer',
      expected_mode: 'answer',
      expected_phase: 'after_subagent',
      expected_latest_announce_kind: 'completed',
      expected_delegation_count: 2,
      expected_transcript_leak: false,
      expected_carryover_seen: false,
      known_issue: 'multi_task_delegation_boundary_reuses_same_lane_delegation',
      reason: 'Known issue for the next multi-task redesign: the second task should start clean, but same-lane delegation reuse currently carries the first task transcript.',
    },
  },
  {
    name: 'limit-reached-continuation-carries-transcript',
    inputs: {
      user_message: '帮我把 data/items.csv 里的所有分片都处理完，全部处理完成后告诉我结果',
      subagent_script: 'tool_calls_until_carryover',
      subagent_final_response: '已处理完 data/items.csv 的全部分片，共 120 条记录，没有失败项。',
    },
    outputs: {
      expected_route: 'answer',
      expected_mode: 'answer',
      expected_phase: 'after_subagent',
      expected_latest_announce_kind: 'completed',
      expected_delegation_count: 1,
      expected_carryover_seen: true,
      reason: 'limit_reached continuation must reuse the delegation id and carry the prior transcript back into the subagent input.',
    },
  },
  {
    name: 'capability-limit-orchestrator-resume-stays-on-explore-lane',
    inputs: {
      user_message: '帮我调查 pinpawo-agent 仓库里 local-agent 的 capability 注册链路，列出关键文件和证据。',
      capability_pack: 'explore',
      capability_candidates: ['explore'],
      subagent_script: 'tool_calls_until_carryover',
      subagent_final_response: '已完成 local-agent capability 注册链路调查：入口在 localAgentCapabilityRegistry，channel 装配后传入 pet-agent orchestrator。',
      max_iterations: 1,
      auto_resume_iteration_limit: true,
    },
    outputs: {
      expected_route: 'answer',
      expected_mode: 'answer',
      expected_phase: 'after_subagent',
      expected_latest_announce_kind: 'completed',
      expected_latest_announce_lane: 'capability:explore',
      expected_delegation_count: 1,
      expected_carryover_seen: true,
      expected_iteration_limit_interrupt_count: 2,
      reason: 'Capability progress caused by subagent limit plus orchestrator iteration-limit resume should continue the same capability lane, then answer.',
    },
  },
  {
    name: 'capability-flow-finishes-after-capability',
    inputs: {
      user_message: '用宠物发帖能力给小白生成今天的小红书日常草稿',
      capability_pack: 'pet_content',
      capability_candidates: ['daily_post'],
      subagent_response: '已生成小白今天的小红书日常草稿，主题是春日晒太阳，并附带标题、正文和标签。',
    },
    outputs: {
      expected_route: 'answer',
      expected_mode: 'answer',
      expected_phase: 'after_subagent',
      expected_latest_announce_kind: 'completed',
      reason: 'Route should delegate to the candidate capability once, then answer from its completed announce.',
    },
  },
];

function loadPinpetConfig(): Record<string, string> {
  try {
    const raw = readFileSync(resolve(homedir(), '.pinpawo', 'config.json'), 'utf8');
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

const pinpawoConfig = loadPinpetConfig();
const LLM_API_KEY = process.env.LLM_API_KEY || pinpawoConfig.llm_api_key;
const LLM_BASE_URL = process.env.LLM_BASE_URL || pinpawoConfig.llm_base_url || 'https://dashscope.aliyuncs.com/compatible-mode/v1';
const LLM_MODEL = process.env.LLM_MODEL || pinpawoConfig.llm_model || 'qwen3.5-plus';

function normalizeStructuredOutputMethod(value: string | undefined): OrchestrationDecisionStructuredOutputConfig['method'] {
  if (!value) return undefined;
  if (['functionCalling', 'jsonMode', 'jsonSchema'].includes(value)) {
    return value as OrchestrationDecisionStructuredOutputConfig['method'];
  }
  throw new Error(`Invalid DECISION_STRUCTURED_OUTPUT_METHOD: ${value}`);
}

const DECISION_STRUCTURED_OUTPUT_METHOD = normalizeStructuredOutputMethod(
  process.env.DECISION_STRUCTURED_OUTPUT_METHOD,
)
  ?? inferStructuredOutputMethod(LLM_MODEL, LLM_BASE_URL);
const DECISION_STRUCTURED_OUTPUT = DECISION_STRUCTURED_OUTPUT_METHOD
  ? { method: DECISION_STRUCTURED_OUTPUT_METHOD } satisfies OrchestrationDecisionStructuredOutputConfig
  : undefined;

if (!LLM_API_KEY) {
  console.error('Missing LLM_API_KEY — set env var or configure ~/.pinpawo/config.json');
  process.exit(1);
}

function buildModelKwargs(model: string) {
  const normalizedModel = model.toLowerCase();
  if (
    normalizedModel.includes('qwen')
    || normalizedModel.includes('glm')
    || normalizedModel.includes('minimax')
  ) {
    return { extra_body: { enable_thinking: false } };
  }
  if (normalizedModel.includes('deepseek')) {
    return { thinking: { type: 'disabled' } };
  }
  return undefined;
}

function requiresStreaming(model: string): boolean {
  return model.toLowerCase().includes('glm-4.5');
}

function messageHasLaneMeta(message: unknown): boolean {
  const pinpawo = (message as { additional_kwargs?: { pinpawo?: unknown } })?.additional_kwargs?.pinpawo;
  return Boolean(pinpawo && typeof pinpawo === 'object' && 'lane' in pinpawo);
}

/**
 * Deterministic subagent model that snapshots every input it receives, so the
 * eval can assert what laneMessages actually fed into each delegation.
 * Subclasses BaseChatModel directly (not FakeListChatModel) because the fake's
 * _streamResponseChunks would bypass _generate on streamed runs.
 *
 * Lane meta MUST be snapshotted at invocation time: tagNewLaneMessages mutates
 * the same message objects after the run, so inspecting stored references
 * later would see post-hoc tags and report false carryover.
 */
class ProbeSubagentModel extends BaseChatModel {
  invocationStats = [];
  respond;

  constructor(respond) {
    super({});
    this.respond = respond;
  }

  _llmType() {
    return 'probe-subagent';
  }

  bindTools() {
    return this;
  }

  async _generate(messages) {
    const nonSystem = messages.filter((message) => message?._getType?.() !== 'system');
    this.invocationStats.push({
      sawLaneMeta: nonSystem.some(messageHasLaneMeta),
      nonSystemTexts: nonSystem.map((message) =>
        typeof message?.content === 'string' ? message.content : ''),
    });
    const message = this.respond(messages, this.invocationStats.length);
    const text = typeof message.content === 'string' ? message.content : '';
    return { generations: [{ text, message }] };
  }
}

/** One plain-text reply per delegation, in order; repeats the last one. */
function buildTextScriptSubagent(responses: string[]) {
  return new ProbeSubagentModel((_messages, invocationIndex) => {
    const response = responses[Math.min(invocationIndex - 1, responses.length - 1)] ?? '';
    return new AIMessage(response);
  });
}

/**
 * Emits tool calls forever until its input contains lane-tagged messages —
 * i.e. until the orchestrator re-delegated with the prior transcript carried
 * over. First run exhausts the subagent recursion limit (limit_reached);
 * the continuation run finishes naturally only if carryover happened.
 * Calls process_next_chunk so the progress preview clearly says "unfinished",
 * otherwise the route model can legitimately answer from the preview alone.
 */
function buildCarryoverProbeSubagent(finalResponse: string) {
  let toolCallCounter = 0;
  return new ProbeSubagentModel((messages) => {
    if (messages.some(messageHasLaneMeta)) {
      return new AIMessage(finalResponse);
    }
    toolCallCounter += 1;
    return new AIMessage({
      content: '',
      tool_calls: [{
        id: `probe-call-${toolCallCounter}`,
        name: 'process_next_chunk',
        args: { source: 'data/items.csv' },
      }],
    });
  });
}

function buildSubagentModel(inputs: Record<string, unknown>): ProbeSubagentModel {
  if (inputs.subagent_script === 'tool_calls_until_carryover') {
    return buildCarryoverProbeSubagent(String(inputs.subagent_final_response ?? '完成。'));
  }
  const responses = Array.isArray(inputs.subagent_responses) && inputs.subagent_responses.length > 0
    ? inputs.subagent_responses.map(String)
    : [String(inputs.subagent_response ?? '')];
  return buildTextScriptSubagent(responses);
}

function buildModels(subagent: ProbeSubagentModel): AgentModels {
  const routeModel = new ChatOpenAI({
    model: LLM_MODEL,
    temperature: 0.3,
    timeout: 180_000,
    apiKey: LLM_API_KEY,
    streaming: requiresStreaming(LLM_MODEL),
    modelKwargs: buildModelKwargs(LLM_MODEL),
    configuration: {
      baseURL: LLM_BASE_URL,
      defaultHeaders: { Authorization: `Bearer ${LLM_API_KEY}` },
    },
  });
  return {
    act: routeModel,
    observe: routeModel,
    subagent,
  };
}

const mockTools = [
  tool(async ({ path }) => `[mock] 文件 ${path} 的内容：\nexport function hello() { return "world"; }`, {
    name: 'read_file',
    description: '读取指定文件的内容',
    schema: z.object({ path: z.string() }),
  }),
  tool(async ({ path }) => `[mock] 已成功写入文件 ${path}`, {
    name: 'write_file',
    description: '写入内容到指定文件',
    schema: z.object({ path: z.string(), content: z.string() }),
  }),
  tool(async ({ command }) => `[mock] 命令 "${command}" 执行完成，退出码 0`,
    {
      name: 'shell',
      description: '在终端中执行命令',
      schema: z.object({ command: z.string() }),
    }),
  tool(async ({ query }) => `[mock] 搜索 "${query}" 的结果：\n1. 相关结果`,
    {
      name: 'web_search',
      description: '在互联网上搜索信息',
      schema: z.object({ query: z.string() }),
  }),
  tool(async ({ source }) => `[mock] 已处理 ${source} 的一个分片，仍有剩余分片未处理完，任务尚未完成，需要继续处理。`,
    {
      name: 'process_next_chunk',
      description: '处理数据源的下一个分片，每次只处理一个分片',
      schema: z.object({ source: z.string() }),
  }),
];

const mockGeneralToolkit = defineToolkit({
  name: 'eval_general',
  description: 'Mock general tools for flow evaluation.',
  tools: mockTools,
});

function evalCapability(
  name: string,
  description: string,
  instructions: string,
): AgentCapability {
  return {
    name,
    description,
    uses: ['eval_general'],
    instructions: defineInstructionDocument({
      content: instructions,
    }),
  };
}

const mockCapabilities: AgentCapability[] = [
  evalCapability(
    'explore',
    '通用探索、调查、资料检索和代码库理解 capability。适合大量阅读、搜索、检查上下文、梳理证据、先探索再决定下一步的任务。',
    '负责只读探索、代码库理解、资料检索和证据汇总。',
  ),
  evalCapability(
    'daily_post',
    '生成、保存或跳过宠物 daily post、小红书日常动态、宠物发帖草稿，并产出本轮动态处理结果。',
    '负责宠物日常内容生成、草稿保存和发布前确认。',
  ),
  evalCapability(
    'trend_observe',
    '浏览或搜索最新的小红书热点/内容趋势，并选出适合宠物账号继续处理的一条。',
    '负责观察内容趋势并给出适合宠物账号的候选主题。',
  ),
  evalCapability(
    'browser',
    '使用本机浏览器打开网页、复用登录态、操作页面、等待页面变化并提取页面内容。',
    '负责浏览器页面访问、交互和内容提取。',
  ),
];

function resolveCapabilityList(pack: unknown): AgentCapability[] {
  if (pack === 'pet_content') {
    return mockCapabilities.filter((capability) => capability.name !== 'browser' && capability.name !== 'explore');
  }
  if (pack === 'browser') return mockCapabilities.filter((capability) => capability.name === 'browser');
  if (pack === 'explore') return mockCapabilities.filter((capability) => capability.name === 'explore');
  if (pack === 'daily_post_only') {
    return mockCapabilities.filter((capability) => capability.name === 'daily_post');
  }
  return [];
}

function readInterruptPayload(result: Record<string, unknown>): Record<string, unknown> | null {
  const interrupts = Array.isArray(result.__interrupt__) ? result.__interrupt__ : [];
  const first = interrupts[0];
  return first && typeof first === 'object' && first.value && typeof first.value === 'object'
    ? first.value as Record<string, unknown>
    : null;
}

function readReviewId(payload: Record<string, unknown> | null): string | null {
  const review = payload?.review && typeof payload.review === 'object'
    ? payload.review as Record<string, unknown>
    : null;
  return typeof review?.id === 'string' ? review.id : null;
}

const testActor: AgentActor = {
  petId: 'eval-pet',
  userId: 'eval-user',
  name: '小白',
  personality: '友好、乐于助人的宠物助手',
  stage: 'adult',
  species: 'cat',
};

let evalCounter = 0;

async function target(inputs: Record<string, unknown>): Promise<Record<string, unknown>> {
  const userMessage = inputs.user_message as string;
  const subagentModel = buildSubagentModel(inputs);
  const models = buildModels(subagentModel);
  const checkpointer = new MemorySaver();
  const graph = createOrchestratorGraph({
    models,
    actor: testActor,
    checkpoint: checkpointer,
    decisionStructuredOutput: DECISION_STRUCTURED_OUTPUT,
  });
  const compiled = await graph;
  const turnInput = buildOrchestratorTurnInput([new HumanMessage(userMessage)]);
  const capabilityList = resolveCapabilityList(inputs.capability_pack);
  const capabilityCandidateNames = Array.isArray(inputs.capability_candidates)
    ? inputs.capability_candidates.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
    : [];

  const configurable = {
    thread_id: `eval-flow-${Date.now()}-${++evalCounter}`,
    actor: testActor,
    toolkits: [mockGeneralToolkit],
    capabilities: capabilityList,
    forcedCapabilityNames: capabilityCandidateNames,
    maxIterations: typeof inputs.max_iterations === 'number' ? inputs.max_iterations : 3,
    workdir: '/mock/project',
  };
  let result = await compiled.invoke(turnInput, {
    configurable: {
      ...configurable,
    },
  });
  let iterationLimitInterruptCount = 0;
  if (inputs.auto_resume_iteration_limit === true) {
    for (let i = 0; i < 5; i += 1) {
      const payload = readInterruptPayload(result as Record<string, unknown>);
      const reviewId = readReviewId(payload);
      if (!reviewId?.startsWith('iteration-limit:')) break;
      iterationLimitInterruptCount += 1;
      result = await compiled.invoke(
        new Command({
          resume: {
            reviewId,
            selectedOptionId: 'approve',
          },
        }),
        { configurable },
      );
    }
  }

  return extractResult(result, inputs, subagentModel, iterationLimitInterruptCount);
}

function extractResult(
  result: Record<string, unknown>,
  inputs: Record<string, unknown>,
  subagentModel: ProbeSubagentModel,
  iterationLimitInterruptCount: number,
): Record<string, unknown> {
  const routeMode = routeModeFromResult(result);
  const finalRoute = routeMode === 'answer' ? 'answer' : 'delegate';
  const messages = Array.isArray(result.messages) ? result.messages : [];
  const visibleMessages = messages.filter((message) => {
    const pinpawo = message?.additional_kwargs?.pinpawo;
    return !pinpawo || typeof pinpawo !== 'object' || !('lane' in pinpawo);
  });
  const lastMsg = visibleMessages.at(-1);
  const latestAnnounce = readLatestAnnounce(
    messages,
    { runId: typeof result.runId === 'string' ? result.runId : null },
  );
  const runDelegationSummaries = readRunDelegationSummaries(result);
  const activeDelegation = readTaskActiveDelegation(result);
  const observedRunDelegations = runDelegationSummaries.filter((delegation) =>
    delegation?.status === 'progress' || delegation?.status === 'completed'
  );
  const latestObservedDelegation = observedRunDelegations.at(-1);

  // Lane-scoping probes over invocation-time snapshots (see ProbeSubagentModel):
  // - transcript_leak: a previous task's reply text showed up in a later
  //   delegation's input (delegationId scoping broken).
  // - carryover_seen: some invocation received lane-tagged messages, i.e. a
  //   continuation of the same delegation carried its transcript back.
  const invocationStats = subagentModel.invocationStats;
  const firstTaskMarker = Array.isArray(inputs.subagent_responses) && typeof inputs.subagent_responses[0] === 'string'
    ? inputs.subagent_responses[0]
    : null;
  const transcriptLeak = firstTaskMarker
    ? invocationStats.some((stat) => stat.nonSystemTexts.some((text) => text.includes(firstTaskMarker)))
    : null;
  const carryoverSeen = invocationStats.some((stat) => stat.sawLaneMeta);

  return {
    route: finalRoute,
    mode: routeMode,
    phase: latestAnnounce || observedRunDelegations.length > 0 || activeDelegation?.status === 'awaiting_decision'
      ? 'after_subagent'
      : 'initial_request',
    reply: typeof lastMsg?.content === 'string' ? lastMsg.content : '',
    delegation_count: runDelegationSummaries.length,
    delegation_statuses: runDelegationSummaries.map((item) => item.status),
    latest_announce_kind: latestObservedDelegation?.status
      ?? (activeDelegation?.status === 'awaiting_decision' ? 'progress' : null),
    latest_announce_lane: latestAnnounce?.lane ?? latestObservedDelegation?.lane ?? activeDelegation?.lane ?? null,
    subagent_invocation_count: invocationStats.length,
    transcript_leak: transcriptLeak,
    carryover_seen: carryoverSeen,
    iteration_limit_interrupt_count: iterationLimitInterruptCount,
  };
}

function exactFieldEvaluator(field: string, expectedField: string) {
  return ({ outputs, referenceOutputs }) => {
    const actual = outputs?.[field];
    const expected = referenceOutputs?.[expectedField];
    if (typeof expected === 'undefined') {
      return { key: `${field}_correct`, score: 1, comment: `No ${expectedField} specified` };
    }
    return {
      key: `${field}_correct`,
      score: actual === expected ? 1 : 0,
      comment: actual === expected
        ? `Correct: ${String(actual)}`
        : `Expected ${field} ${String(expected)}, got ${String(actual)}`,
    };
  };
}

function delegationCountEvaluator({ outputs, referenceOutputs }) {
  const expected = typeof referenceOutputs?.expected_delegation_count === 'number'
    ? referenceOutputs.expected_delegation_count
    : 1;
  const count = outputs?.delegation_count;
  return {
    key: 'delegation_count_correct',
    score: count === expected ? 1 : 0,
    comment: count === expected
      ? `Correct: ${String(count)} delegation(s)`
      : `Expected ${expected} subagent delegation(s), got ${String(count)}`,
  };
}

async function ensureDataset() {
  if (process.env.SKIP_DATASET_SYNC === '1') {
    console.log(`Using existing LangSmith dataset "${DATASET_NAME}" (SKIP_DATASET_SYNC=1).`);
    return;
  }

  const client = new Client();
  try {
    const existing = await client.readDataset({ datasetName: DATASET_NAME });
    if (existing) {
      await client.deleteDataset({ datasetId: existing.id });
    }
  } catch {}

  const dataset = await client.createDataset(DATASET_NAME, {
    description: 'End-to-end orchestrator flow eval with real route model and mocked subagent model.',
  });
  for (const example of examples) {
    await client.createExample({
      dataset_id: dataset.id,
      inputs: example.inputs,
      outputs: example.outputs,
      metadata: { name: example.name },
    });
  }
}

async function main() {
  await ensureDataset();
  console.log(`Running orchestrator flow mock-subagent evaluation against "${DATASET_NAME}"...`);
  console.log(`Route model: ${LLM_MODEL} @ ${LLM_BASE_URL}`);
  if (DECISION_STRUCTURED_OUTPUT) {
    console.log('Route structured output:', JSON.stringify(DECISION_STRUCTURED_OUTPUT));
  }
  console.log('');

  const results = await evaluate(target, {
    data: DATASET_NAME,
    evaluators: [
      exactFieldEvaluator('route', 'expected_route'),
      exactFieldEvaluator('mode', 'expected_mode'),
      exactFieldEvaluator('phase', 'expected_phase'),
      exactFieldEvaluator('latest_announce_kind', 'expected_latest_announce_kind'),
      exactFieldEvaluator('latest_announce_lane', 'expected_latest_announce_lane'),
      exactFieldEvaluator('transcript_leak', 'expected_transcript_leak'),
      exactFieldEvaluator('carryover_seen', 'expected_carryover_seen'),
      exactFieldEvaluator('iteration_limit_interrupt_count', 'expected_iteration_limit_interrupt_count'),
      delegationCountEvaluator,
    ],
    experimentPrefix: 'orchestrator-flow-mock-subagent',
    maxConcurrency: 1,
  });

  const rows = results.results;
  const keys = [
    'route_correct',
    'mode_correct',
    'phase_correct',
    'latest_announce_kind_correct',
    'latest_announce_lane_correct',
    'transcript_leak_correct',
    'carryover_seen_correct',
    'iteration_limit_interrupt_count_correct',
    'delegation_count_correct',
  ];
  console.log('\n=== Evaluation complete ===');
  for (const key of keys) {
    const scores = rows.flatMap((row) => row.evaluationResults.results.filter((item) => item.key === key));
    const passed = scores.filter((item) => item.score === 1).length;
    console.log(`${key}: ${passed}/${scores.length} passed, ${scores.length - passed} failed.`);
  }
  for (const row of rows) {
    const failedScores = row.evaluationResults.results.filter((item) => keys.includes(item.key) && item.score !== 1);
    if (failedScores.length === 0) continue;
    const knownIssue = typeof row.example.outputs?.known_issue === 'string'
      ? ` [KNOWN ISSUE: ${row.example.outputs.known_issue}]`
      : '';
    console.log(`  - ${row.example.metadata?.name ?? row.example.id}${knownIssue}: ${failedScores.map((item) => item.comment).join(' | ')}`);
  }
  console.log('View results in LangSmith dashboard.');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
