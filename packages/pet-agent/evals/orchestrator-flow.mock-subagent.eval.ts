// @ts-nocheck — eval script, types from langsmith barrel are incomplete
/**
 * LangSmith evaluation: orchestrator flow with mocked subagent.
 *
 * This runs the real orchestrator graph through route -> subagent -> route.
 * The route model is the configured real model; only the subagent model is a
 * deterministic fake chat model that returns the example's subagent_response.
 *
 * Run:
 *   LLM_BASE_URL=... LLM_MODEL=... DECISION_STRUCTURED_OUTPUT_METHOD=functionCalling \
 *     npx tsx evals/orchestrator-flow.mock-subagent.eval.ts
 */
import { evaluate } from 'langsmith/evaluation';
import { Client } from 'langsmith';
import { ChatOpenAI } from '@langchain/openai';
import { AIMessage, HumanMessage } from '@langchain/core/messages';
import { FakeListChatModel } from '@langchain/core/utils/testing';
import { MemorySaver } from '@langchain/langgraph';
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
import type { AgentCapability } from '../src/types/capability';
import { readLatestAnnounce } from '../src/agent/orchestrator/messageLanes';

const DATASET_NAME = 'orchestrator-flow-mock-subagent';

const examples = [
  {
    name: 'file-read-flow-finishes-after-general',
    inputs: {
      user_message: '帮我看一下 src/index.ts 的内容',
      subagent_response: '已读取 src/index.ts，文件导出了 createApp 和 startServer 两个入口函数。',
    },
    outputs: {
      expected_route: 'finish',
      expected_mode: 'finish',
      expected_phase: 'after_subagent',
      expected_latest_announce_kind: 'completed',
      reason: 'Route should delegate file reading once, consume completed announce, then finish.',
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
      expected_route: 'finish',
      expected_mode: 'finish',
      expected_phase: 'after_subagent',
      expected_latest_announce_kind: 'completed',
      expected_latest_announce_lane: 'capability:browser',
      reason: 'A completed browser announce should be enough for route to finish, not re-delegate.',
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
      expected_route: 'finish',
      expected_mode: 'finish',
      expected_phase: 'after_subagent',
      expected_latest_announce_kind: 'completed',
      reason: 'A completed lookup should finish even if capability discovery found a daily_post candidate from keyword overlap.',
    },
  },
  {
    name: 'multi-action-flow-finishes-when-subagent-completes-all',
    inputs: {
      user_message: '帮我把当前项目里的所有 var 声明改成 const，并运行 lint 检查',
      subagent_response: '已将所有 var 声明改成 const，并运行 lint 检查；lint 通过，退出码 0。',
    },
    outputs: {
      expected_route: 'finish',
      expected_mode: 'finish',
      expected_phase: 'after_subagent',
      expected_latest_announce_kind: 'completed',
      reason: 'When the subagent completed both requested actions, route should finish.',
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
      expected_route: 'finish',
      expected_mode: 'finish',
      expected_phase: 'after_subagent',
      expected_latest_announce_kind: 'completed',
      reason: 'Route should delegate to the candidate capability once, then finish from its completed announce.',
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

function inferDefaultStructuredOutputMethod(model: string): OrchestrationDecisionStructuredOutputConfig['method'] {
  const normalized = model.toLowerCase();
  if (normalized.includes('deepseek')) return 'functionCalling';
  return undefined;
}

const DECISION_STRUCTURED_OUTPUT_METHOD = normalizeStructuredOutputMethod(
  process.env.DECISION_STRUCTURED_OUTPUT_METHOD,
)
  ?? inferDefaultStructuredOutputMethod(LLM_MODEL);
const DECISION_STRUCTURED_OUTPUT = DECISION_STRUCTURED_OUTPUT_METHOD
  ? { method: DECISION_STRUCTURED_OUTPUT_METHOD } satisfies OrchestrationDecisionStructuredOutputConfig
  : undefined;

if (!LLM_API_KEY) {
  console.error('Missing LLM_API_KEY — set env var or configure ~/.pinpawo/config.json');
  process.exit(1);
}

function buildModelKwargs(model: string) {
  if (model.includes('qwen') || model.includes('glm')) {
    return { extra_body: { enable_thinking: false } };
  }
  if (model.includes('deepseek')) {
    return { thinking: { type: 'disabled' } };
  }
  return undefined;
}

function buildModels(subagentResponse: string): AgentModels {
  const routeModel = new ChatOpenAI({
    model: LLM_MODEL,
    temperature: 0.3,
    timeout: 180_000,
    apiKey: LLM_API_KEY,
    modelKwargs: buildModelKwargs(LLM_MODEL),
    configuration: {
      baseURL: LLM_BASE_URL,
      defaultHeaders: { Authorization: `Bearer ${LLM_API_KEY}` },
    },
  });
  const subagent = new FakeListChatModel({
    responses: [subagentResponse],
    sleep: 0,
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
];

const mockCapabilities: AgentCapability[] = [
  {
    name: 'daily_post',
    description: '生成、保存或跳过宠物 daily post、小红书日常动态、宠物发帖草稿，并产出本轮动态处理结果。',
    createRuntime: () => ({
      instructions: ['负责宠物日常内容生成、草稿保存和发布前确认。'],
      tools: [],
    }),
  },
  {
    name: 'trend_observe',
    description: '浏览或搜索最新的小红书热点/内容趋势，并选出适合宠物账号继续处理的一条。',
    createRuntime: () => ({
      instructions: ['负责观察内容趋势并给出适合宠物账号的候选主题。'],
      tools: [],
    }),
  },
  {
    name: 'browser',
    description: '使用本机浏览器打开网页、复用登录态、操作页面、等待页面变化并提取页面内容。',
    createRuntime: () => ({
      instructions: ['负责浏览器页面访问、交互和内容提取。'],
      tools: [],
    }),
  },
];

function resolveCapabilityList(pack: unknown): AgentCapability[] {
  if (pack === 'pet_content') return mockCapabilities.filter((capability) => capability.name !== 'browser');
  if (pack === 'browser') return mockCapabilities.filter((capability) => capability.name === 'browser');
  if (pack === 'daily_post_only') {
    return mockCapabilities.filter((capability) => capability.name === 'daily_post');
  }
  return [];
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
  const subagentResponse = inputs.subagent_response as string;
  const models = buildModels(subagentResponse);
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

  if (capabilityCandidateNames.length > 0) {
    turnInput.capabilitySearchState = {
      query: 'eval',
      attempted: true,
      candidates: capabilityCandidateNames.flatMap((name) => {
        const capability = capabilityList.find((item) => item.name === name);
        if (!capability) return [];
        return [{
          name: capability.name,
          description: capability.description,
          score: 100,
          matchedTerms: ['eval'],
        }];
      }),
    };
  }

  const result = await compiled.invoke(turnInput, {
    configurable: {
      thread_id: `eval-flow-${Date.now()}-${++evalCounter}`,
      actor: testActor,
      tools: mockTools,
      capabilities: capabilityList,
      maxIterations: 3,
      workdir: '/mock/project',
    },
  });

  return extractResult(result);
}

function extractResult(result: Record<string, unknown>): Record<string, unknown> {
  const pendingDelegation = result.pendingDelegation && typeof result.pendingDelegation === 'object'
    ? result.pendingDelegation as Record<string, unknown>
    : null;
  const lane = pendingDelegation?.lane;
  const routeMode = lane === 'general'
    ? 'general'
    : typeof lane === 'string' && lane.startsWith('capability:')
      ? 'capability'
      : 'finish';
  const finalRoute = routeMode === 'finish' ? 'finish' : 'delegate';
  const messages = Array.isArray(result.messages) ? result.messages : [];
  const visibleMessages = messages.filter((message) => {
    const pinpawo = message?.additional_kwargs?.pinpawo;
    return !pinpawo || typeof pinpawo !== 'object' || !('lane' in pinpawo);
  });
  const lastMsg = visibleMessages.at(-1);
  const latestAnnounce = readLatestAnnounce(
    messages,
    { turnId: typeof result.turnId === 'string' ? result.turnId : null },
  );
  const turnDelegations = Array.isArray(result.turnDelegations) ? result.turnDelegations : [];
  return {
    route: finalRoute,
    mode: routeMode,
    phase: latestAnnounce ? 'after_subagent' : 'initial_request',
    reply: typeof lastMsg?.content === 'string' ? lastMsg.content : '',
    delegation_count: turnDelegations.length,
    delegation_statuses: turnDelegations.map((item) => item.status),
    latest_announce_kind: latestAnnounce?.announce ?? null,
    latest_announce_lane: latestAnnounce?.lane ?? null,
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

function delegationCountEvaluator({ outputs }) {
  const count = outputs?.delegation_count;
  return {
    key: 'delegation_count_correct',
    score: count === 1 ? 1 : 0,
    comment: count === 1
      ? 'Correct: delegated exactly once'
      : `Expected exactly one subagent delegation, got ${String(count)}`,
  };
}

async function ensureDataset() {
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
    console.log(`  - ${row.example.metadata?.name ?? row.example.id}: ${failedScores.map((item) => item.comment).join(' | ')}`);
  }
  console.log('View results in LangSmith dashboard.');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
