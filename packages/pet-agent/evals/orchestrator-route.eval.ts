// @ts-nocheck — eval script, types from langsmith barrel are incomplete
/**
 * LangSmith evaluation: orchestrator route decision
 *
 * Tests whether the orchestrator correctly decides to answer vs. delegate.
 * Uses the dataset created by `dataset.ts`.
 *
 * Required env vars:
 *   LANGCHAIN_API_KEY     — LangSmith API key
 *   LANGCHAIN_TRACING_V2  — set to "true" to enable tracing
 *   LLM_API_KEY           — model provider API key
 *   LLM_BASE_URL          — model provider base URL (default: dashscope)
 *   LLM_MODEL             — model name (default: qwen3.5-plus)
 *   DECISION_STRUCTURED_OUTPUT_METHOD — optional override (functionCalling, jsonMode, jsonSchema)
 *
 * Run: npx tsx evals/orchestrator-route.eval.ts
 */
import { evaluate } from 'langsmith/evaluation';
import { Client } from 'langsmith';
import { ChatOpenAI } from '@langchain/openai';
import { HumanMessage, SystemMessage, AIMessage } from '@langchain/core/messages';
import {
  createOrchestratorGraph,
  buildOrchestratorTurnInput,
  type OrchestrationDecisionStructuredOutputConfig,
} from '../src/agent/createAgentRuntime';
import type { AgentActor, AgentModels } from '../src/types/agent';
import type { AgentCapability } from '../src/types/capability';
import { defineToolkit } from '../src/types/toolkit';
import { inferStructuredOutputMethod } from '../src/utils/structuredOutput';
import { readLatestAnnounce } from '../src/agent/orchestrator/messageLanes';
import {
  activeCapabilityFromResult,
  hasObservedDelegation,
  readCapabilitySearchState,
  routeModeFromResult,
} from './orchestratorStateReaders';
import { MemorySaver } from '@langchain/langgraph';
import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { homedir } from 'node:os';
import { pathToFileURL } from 'node:url';

export const DATASET_NAME = 'orchestrator-route-decision';

// ── Model setup (env vars → ~/.pinpawo/config.json fallback) ──

function loadPinpetConfig(): Record<string, string> {
  try {
    const raw = readFileSync(resolve(homedir(), '.pinpawo', 'config.json'), 'utf8');
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function loadPinpawoEnv(): Record<string, string> {
  try {
    const raw = readFileSync(resolve(homedir(), '.pinpawo', '.env'), 'utf8');
    const env: Record<string, string> = {};
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const separator = trimmed.indexOf('=');
      if (separator < 0) continue;
      const key = trimmed.slice(0, separator).trim();
      let value = trimmed.slice(separator + 1).trim();
      if (
        (value.startsWith('"') && value.endsWith('"'))
        || (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      env[key] = value;
    }
    return env;
  } catch {
    return {};
  }
}

const pinpawoConfig = loadPinpetConfig();
const pinpawoEnv = loadPinpawoEnv();
const LLM_API_KEY = process.env.LLM_API_KEY || pinpawoEnv.LLM_API_KEY || pinpawoConfig.llm_api_key;
export const LLM_BASE_URL = process.env.LLM_BASE_URL || pinpawoEnv.LLM_BASE_URL || pinpawoConfig.llm_base_url || 'https://dashscope.aliyuncs.com/compatible-mode/v1';
export const LLM_MODEL = process.env.LLM_MODEL || pinpawoEnv.LLM_MODEL || pinpawoConfig.llm_model || 'qwen3.5-plus';

function normalizeStructuredOutputMethod(value: string | undefined): OrchestrationDecisionStructuredOutputConfig['method'] {
  if (!value) return undefined;
  if (['functionCalling', 'jsonMode', 'jsonSchema'].includes(value)) {
    return value as OrchestrationDecisionStructuredOutputConfig['method'];
  }
  throw new Error(
    `Invalid DECISION_STRUCTURED_OUTPUT_METHOD: ${value}. ` +
    'Use functionCalling, jsonMode, or jsonSchema.',
  );
}

const DECISION_STRUCTURED_OUTPUT_METHOD = normalizeStructuredOutputMethod(
  process.env.DECISION_STRUCTURED_OUTPUT_METHOD,
)
  ?? inferStructuredOutputMethod(LLM_MODEL, LLM_BASE_URL);
const DECISION_STRUCTURED_OUTPUT_STRICT = (() => {
  const raw = process.env.DECISION_STRUCTURED_OUTPUT_STRICT;
  const normalized = raw?.trim().toLowerCase();
  if (!normalized) return undefined;
  if (['1', 'true', 'yes', 'y', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'n', 'off'].includes(normalized)) return false;
  throw new Error(`Invalid DECISION_STRUCTURED_OUTPUT_STRICT: ${raw}`);
})();
const DECISION_STRUCTURED_OUTPUT = (
  DECISION_STRUCTURED_OUTPUT_METHOD
    || typeof DECISION_STRUCTURED_OUTPUT_STRICT === 'boolean'
)
  ? {
      method: DECISION_STRUCTURED_OUTPUT_METHOD,
      strict: DECISION_STRUCTURED_OUTPUT_STRICT,
    } satisfies OrchestrationDecisionStructuredOutputConfig
  : undefined;

function buildEvalModels(): AgentModels {
  if (!LLM_API_KEY) {
    throw new Error('Missing LLM_API_KEY — set env var, ~/.pinpawo/.env, or ~/.pinpawo/config.json');
  }
  const normalizedModel = LLM_MODEL.toLowerCase();
  const modelKwargs = (
    normalizedModel.includes('qwen')
    || normalizedModel.includes('glm')
    || normalizedModel.includes('minimax')
  )
    ? { extra_body: { enable_thinking: false } }
    : normalizedModel.includes('deepseek')
      ? { thinking: { type: 'disabled' } }
      : undefined;
  const model = new ChatOpenAI({
    model: LLM_MODEL,
    temperature: 0.3, // lower for more deterministic eval
    timeout: 180_000,
    apiKey: LLM_API_KEY,
    streaming: normalizedModel.includes('glm-4.5'),
    modelKwargs,
    configuration: {
      baseURL: LLM_BASE_URL,
      defaultHeaders: { Authorization: `Bearer ${LLM_API_KEY}` },
    },
  });
  return { act: model, observe: model };
}

// ── Mock tools (simulate available general tools) ──

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
  tool(async ({ command }) => {
    // lint/check 类命令模拟发现问题，需要后续修复
    if (/lint|eslint|tsc|check|test/.test(command)) {
      return `[mock] 命令 "${command}" 执行完成，退出码 1\n\nsrc/utils.ts:12:5 error Unexpected var, use let or const (no-var)\nsrc/helpers.ts:8:3 error Unexpected var, use let or const (no-var)\n\n✖ 2 problems (2 errors, 0 warnings)`;
    }
    return `[mock] 命令 "${command}" 执行完成，退出码 0`;
  }, {
    name: 'shell',
    description: '在终端中执行命令',
    schema: z.object({ command: z.string() }),
  }),
  tool(async ({ query }) => `[mock] 搜索 "${query}" 的结果：\n1. 相关文档页面\n2. GitHub 仓库\n3. 技术博客文章`, {
    name: 'web_search',
    description: '在互联网上搜索信息',
    schema: z.object({ query: z.string() }),
  }),
];

const mockGeneralToolkit = defineToolkit({
  name: 'eval_general',
  description: 'Mock general tools for route evaluation.',
  tools: mockTools,
});

const mockCapabilities: AgentCapability[] = [
  {
    name: 'explore',
    description: '通用探索、调查、资料检索和代码库理解 capability。适合大量阅读、搜索、检查上下文、梳理证据、先探索再决定下一步的任务。',
    createRuntime: () => ({
      instructions: ['负责只读探索、代码库理解、资料检索和证据汇总。'],
      tools: [],
    }),
  },
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

const testActor: AgentActor = {
  petId: 'eval-pet',
  userId: 'eval-user',
  name: '小白',
  personality: '友好、乐于助人的宠物助手',
  stage: 'adult',
  species: 'cat',
};

// ── Target function: run orchestrator and return route decision ──

let evalCounter = 0;

function resolveCapabilityList(pack: unknown): AgentCapability[] {
  if (pack === 'pet_content') {
    return mockCapabilities.filter((capability) => capability.name !== 'browser' && capability.name !== 'explore');
  }
  if (pack === 'browser') {
    return mockCapabilities.filter((capability) => capability.name === 'browser');
  }
  if (pack === 'explore') {
    return mockCapabilities.filter((capability) => capability.name === 'explore');
  }
  return [];
}

export async function target(
  inputs: Record<string, unknown>,
  modelOverride?: AgentModels,
): Promise<Record<string, unknown>> {
  const models = modelOverride ?? buildEvalModels();
  const checkpointer = new MemorySaver();
  const graph = createOrchestratorGraph({
    models,
    actor: testActor,
    checkpoint: checkpointer,
    decisionStructuredOutput: DECISION_STRUCTURED_OUTPUT,
  });
  const compiled = await graph;
  const threadId = `eval-${Date.now()}-${++evalCounter}`;

  const userMessage = inputs.user_message as string;
  const capabilityList = resolveCapabilityList(inputs.capability_pack);

  const resumeProgressLane = typeof inputs.resume_progress_lane === 'string'
    && inputs.resume_progress_lane.trim()
    ? inputs.resume_progress_lane.trim()
    : null;
  const turnInput = buildOrchestratorTurnInput(resumeProgressLane
    ? [
        new HumanMessage(String(inputs.resume_original_user_message ?? userMessage)),
        new AIMessage({
          content: String(inputs.resume_progress_result ?? ''),
          additional_kwargs: {
            pinpawo: {
              lane: resumeProgressLane,
              runId: 'previous-turn',
              isAnnounce: true,
              delegationId: 'resume-progress-1',
              task: String(inputs.resume_progress_task ?? inputs.resume_original_user_message ?? userMessage),
              ...(typeof inputs.resume_progress_completion_reason === 'string'
                ? { completionReason: inputs.resume_progress_completion_reason }
                : {}),
            },
          },
        }),
        new HumanMessage(userMessage),
      ]
    : [new HumanMessage(userMessage)]);
  if (resumeProgressLane) {
    turnInput.taskActiveDelegation = {
      id: 'resume-progress-1',
      lane: resumeProgressLane,
      task: String(inputs.resume_progress_task ?? inputs.resume_original_user_message ?? userMessage),
      contextSummary: null,
      transcriptRunId: 'previous-turn',
      status: 'awaiting_decision',
      resultPreview: String(inputs.resume_progress_result ?? ''),
    };
  }
  const completedResults = Array.isArray(inputs.completed_results)
    ? inputs.completed_results.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
    : [];
  const completedTasks = Array.isArray(inputs.completed_tasks)
    ? inputs.completed_tasks.map((item) => typeof item === 'string' && item.trim().length > 0 ? item : null)
    : [];
  const progressResults = Array.isArray(inputs.progress_results)
    ? inputs.progress_results.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
    : [];
  if (completedResults.length > 0) {
    turnInput.runDelegationSummaries = completedResults.map((text, index) => ({
      id: `eval-${index + 1}`,
      lane: 'general',
      task: completedTasks[index] ?? userMessage,
      status: 'completed',
      resultPreview: text,
    }));
    turnInput.messages.push(
      ...completedResults.map((text, index) => new AIMessage({
        content: text,
        additional_kwargs: {
          pinpawo: {
            lane: 'general',
            runId: turnInput.runId,
            isAnnounce: true,
            delegationId: `eval-${index + 1}`,
            task: completedTasks[index] ?? userMessage,
            completionReason: 'natural',
          },
        },
      })),
    );
  }
  if (progressResults.length > 0) {
    const offset = turnInput.runDelegationSummaries.length;
    const progressSummaries = progressResults.map((text, index) => ({
      id: `eval-${offset + index + 1}`,
      lane: 'general',
      task: userMessage,
      status: 'progress',
      resultPreview: text,
    }));
    turnInput.runDelegationSummaries.push(...progressSummaries);
    const latestProgress = progressSummaries.at(-1);
    if (latestProgress) {
      turnInput.taskActiveDelegation = {
        id: latestProgress.id,
        lane: latestProgress.lane,
        task: latestProgress.task,
        contextSummary: null,
        transcriptRunId: turnInput.runId,
        status: 'awaiting_decision',
        resultPreview: latestProgress.resultPreview,
      };
    }
    turnInput.messages.push(
      ...progressResults.map((text, index) => new AIMessage({
        content: text,
        additional_kwargs: {
          pinpawo: {
            lane: 'general',
            runId: turnInput.runId,
            isAnnounce: true,
            delegationId: `eval-${offset + index + 1}`,
            task: userMessage,
            completionReason: 'limit_reached',
          },
        },
      })),
    );
  }
  const capabilityCandidateNames = Array.isArray(inputs.capability_candidates)
    ? inputs.capability_candidates.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
    : [];

  // Evaluate through task/search + route decision, but stop before executing subagents.
  const result = await compiled.invoke(turnInput, {
    interruptBefore: ['capability', 'general'],
    configurable: {
      thread_id: threadId,
      actor: testActor,
      toolkits: [mockGeneralToolkit],
      capabilities: capabilityList,
      forcedCapabilityNames: capabilityCandidateNames,
      maxIterations: 1,
    },
  });
  return extractResult(result, capabilityList);
}

function hasCurrentSubagentObservation(result: Record<string, unknown>): boolean {
  if (latestAnnounceFromResult(result)) return true;
  return hasObservedDelegation(result);
}

function capabilityStateFromResult(result: Record<string, unknown>, capabilityList: AgentCapability[]): string {
  if (activeCapabilityFromResult(result)) return 'candidates_available';
  const search = readCapabilitySearchState(result);
  const candidates = search.candidates;
  if (hasCurrentSubagentObservation(result)) return 'unavailable';
  if (candidates.length > 0) return 'candidates_available';
  if (search.attempted === true) return 'search_exhausted';
  if (capabilityList.length > 0) return 'search_available';
  return 'unavailable';
}

function latestAnnounceFromResult(result: Record<string, unknown>) {
  const messages = Array.isArray(result.messages) ? result.messages : [];
  const runId = typeof result.runId === 'string' ? result.runId : null;
  return readLatestAnnounce(messages, { runId });
}

function extractResult(result: Record<string, unknown>, capabilityList: AgentCapability[]): Record<string, unknown> {
  const routeMode = routeModeFromResult(result);
  const finalRoute = routeMode === 'answer' ? 'answer' : 'delegate';
  const latestAnnounce = latestAnnounceFromResult(result);
  const messages = result.messages as { content?: unknown; _getType?: () => string }[] | undefined;
  const lastMsg = messages?.at(-1);
  const reply = lastMsg && typeof lastMsg.content === 'string' ? lastMsg.content : '';
  const capabilitySearchState = readCapabilitySearchState(result);
  const rawCandidates = Array.isArray(capabilitySearchState.candidates) ? capabilitySearchState.candidates : [];
  const activeCapability = activeCapabilityFromResult(result);
  const capabilityCandidates = rawCandidates.flatMap((candidate) => {
        if (!candidate || typeof candidate !== 'object') return [];
        const name = (candidate as { name?: unknown }).name;
        return typeof name === 'string' ? [name] : [];
      });
  const inferredCapabilityCandidates = capabilityCandidates.length > 0
    ? capabilityCandidates
    : activeCapability ? [activeCapability] : [];
  return {
    route: finalRoute,
    mode: routeMode,
    phase: latestAnnounce || hasCurrentSubagentObservation(result) ? 'after_subagent' : 'initial_request',
    capability_state: capabilityStateFromResult(result, capabilityList),
    active_capability: activeCapability,
    capability_search_query: capabilitySearchState.query,
    capability_candidates: inferredCapabilityCandidates,
    reply,
  };
}

// ── Evaluators ──

export function routeCorrectness({
  outputs,
  referenceOutputs,
}: {
  outputs: Record<string, unknown> | undefined;
  referenceOutputs: Record<string, unknown> | undefined;
}) {
  const actual = outputs?.route as string | undefined;
  const expected = referenceOutputs?.expected_route as string | undefined;
  return {
    key: 'route_correct',
    score: actual === expected ? 1 : 0,
    comment: actual === expected
      ? `Correct: ${actual}`
      : `Expected ${expected}, got ${actual}`,
  };
}

export function finishBias({
  outputs,
  referenceOutputs,
}: {
  outputs: Record<string, unknown> | undefined;
  referenceOutputs: Record<string, unknown> | undefined;
}) {
  const actual = outputs?.route as string;
  const expected = referenceOutputs?.expected_route as string;
  // 1 = correctly handled answer cases, 0 = should have answered but delegated
  if (expected === 'answer' && actual !== 'answer') {
    return {
      key: 'finish_correct',
      score: 0,
      comment: 'Should have answered but delegated instead',
    };
  }
  return {
    key: 'finish_correct',
    score: 1,
  };
}

export function delegateBias({
  outputs,
  referenceOutputs,
}: {
  outputs: Record<string, unknown> | undefined;
  referenceOutputs: Record<string, unknown> | undefined;
}) {
  const actual = outputs?.route as string;
  const expected = referenceOutputs?.expected_route as string;
  // 1 = correctly handled delegate cases, 0 = should have delegated but answered
  if (expected === 'delegate' && actual !== 'delegate') {
    return {
      key: 'delegate_correct',
      score: 0,
      comment: 'Should have delegated but answered instead',
    };
  }
  return {
    key: 'delegate_correct',
    score: 1,
  };
}

export function modeCorrectness({
  outputs,
  referenceOutputs,
}: {
  outputs: Record<string, unknown> | undefined;
  referenceOutputs: Record<string, unknown> | undefined;
}) {
  const expected = referenceOutputs?.expected_mode as string | undefined;
  if (!expected) {
    return { key: 'mode_correct', score: 1, comment: 'No expected mode specified' };
  }
  const actual = outputs?.mode as string | undefined;
  return {
    key: 'mode_correct',
    score: actual === expected ? 1 : 0,
    comment: actual === expected
      ? `Correct: ${actual}`
      : `Expected mode ${expected}, got ${actual}`,
  };
}

export function phaseCorrectness({
  outputs,
  referenceOutputs,
}: {
  outputs: Record<string, unknown> | undefined;
  referenceOutputs: Record<string, unknown> | undefined;
}) {
  const expected = referenceOutputs?.expected_phase as string | undefined;
  if (!expected) {
    return { key: 'phase_correct', score: 1, comment: 'No expected phase specified' };
  }
  const actual = outputs?.phase as string | undefined;
  return {
    key: 'phase_correct',
    score: actual === expected ? 1 : 0,
    comment: actual === expected
      ? `Correct: ${actual}`
      : `Expected phase ${expected}, got ${actual}`,
  };
}

export function capabilityStateCorrectness({
  outputs,
  referenceOutputs,
}: {
  outputs: Record<string, unknown> | undefined;
  referenceOutputs: Record<string, unknown> | undefined;
}) {
  const expected = referenceOutputs?.expected_capability_state as string | undefined;
  if (!expected) {
    return { key: 'capability_state_correct', score: 1, comment: 'No expected capability state specified' };
  }
  const actual = outputs?.capability_state as string | undefined;
  return {
    key: 'capability_state_correct',
    score: actual === expected ? 1 : 0,
    comment: actual === expected
      ? `Correct: ${actual}`
      : `Expected capability state ${expected}, got ${actual}`,
  };
}

export function activeCapabilityCorrectness({
  outputs,
  referenceOutputs,
}: {
  outputs: Record<string, unknown> | undefined;
  referenceOutputs: Record<string, unknown> | undefined;
}) {
  if (!referenceOutputs || !('expected_active_capability' in referenceOutputs)) {
    return { key: 'active_capability_correct', score: 1, comment: 'No expected active capability specified' };
  }
  const expected = referenceOutputs.expected_active_capability ?? null;
  const actual = outputs?.active_capability ?? null;
  return {
    key: 'active_capability_correct',
    score: actual === expected ? 1 : 0,
    comment: actual === expected
      ? `Correct: ${actual ?? 'null'}`
      : `Expected active capability ${expected ?? 'null'}, got ${actual ?? 'null'}`,
  };
}

export function capabilityCandidatesCorrectness({
  outputs,
  referenceOutputs,
}: {
  outputs: Record<string, unknown> | undefined;
  referenceOutputs: Record<string, unknown> | undefined;
}) {
  const actual = Array.isArray(outputs?.capability_candidates)
    ? outputs.capability_candidates.filter((item): item is string => typeof item === 'string')
    : [];
  if (referenceOutputs?.expected_capability_candidates_empty === true) {
    return {
      key: 'capability_candidates_correct',
      score: actual.length === 0 ? 1 : 0,
      comment: actual.length === 0
        ? 'Correct: no candidates'
        : `Expected no candidates, got ${actual.join(', ')}`,
    };
  }
  const expectedIncludes = Array.isArray(referenceOutputs?.expected_capability_candidates_include)
    ? referenceOutputs.expected_capability_candidates_include.filter((item): item is string => typeof item === 'string')
    : [];
  if (expectedIncludes.length === 0) {
    return { key: 'capability_candidates_correct', score: 1, comment: 'No expected capability candidates specified' };
  }
  const missing = expectedIncludes.filter((name) => !actual.includes(name));
  return {
    key: 'capability_candidates_correct',
    score: missing.length === 0 ? 1 : 0,
    comment: missing.length === 0
      ? `Correct: includes ${expectedIncludes.join(', ')}`
      : `Expected candidates to include ${missing.join(', ')}; got ${actual.join(', ') || '(none)'}`,
  };
}

export function capabilitySearchQueryCorrectness({
  outputs,
  referenceOutputs,
}: {
  outputs: Record<string, unknown> | undefined;
  referenceOutputs: Record<string, unknown> | undefined;
}) {
  const expectedTerms = Array.isArray(referenceOutputs?.expected_capability_search_query_terms)
    ? referenceOutputs.expected_capability_search_query_terms.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
    : [];
  if (expectedTerms.length === 0) {
    return { key: 'capability_search_query_correct', score: 1, comment: 'No expected search query terms specified' };
  }
  const actual = typeof outputs?.capability_search_query === 'string'
    ? outputs.capability_search_query
    : '';
  const normalizedActual = actual.replace(/\s+/g, '').toLowerCase();
  const missing = expectedTerms.filter((term) => !normalizedActual.includes(term.replace(/\s+/g, '').toLowerCase()));
  return {
    key: 'capability_search_query_correct',
    score: missing.length === 0 ? 1 : 0,
    comment: missing.length === 0
      ? `Correct query: ${actual}`
      : `Expected search query to contain ${missing.join(', ')}; got ${actual || '(empty)'}`,
  };
}

// ── Run evaluation ──

async function main() {
  const client = new Client();

  // Verify dataset exists
  try {
    await client.readDataset({ datasetName: DATASET_NAME });
  } catch {
    console.error(
      `Dataset "${DATASET_NAME}" not found. Run \`npx tsx evals/dataset.ts\` first.`,
    );
    process.exit(1);
  }

  console.log(`Running orchestrator route evaluation against "${DATASET_NAME}"...`);
  console.log(`Model: ${LLM_MODEL} @ ${LLM_BASE_URL}\n`);
  if (DECISION_STRUCTURED_OUTPUT) {
    console.log('Route structured output:', JSON.stringify(DECISION_STRUCTURED_OUTPUT), '\n');
  }

  const results = await evaluate(target, {
    data: DATASET_NAME,
    evaluators: [
      routeCorrectness,
      modeCorrectness,
      phaseCorrectness,
      capabilityStateCorrectness,
      activeCapabilityCorrectness,
      capabilityCandidatesCorrectness,
      capabilitySearchQueryCorrectness,
      finishBias,
      delegateBias,
    ],
    experimentPrefix: 'orchestrator-route',
    maxConcurrency: 1,
  });

  const rows = results.results;

  const summarizeScore = (key: string) => {
    const scores = rows.flatMap((row) =>
      row.evaluationResults.results.filter((item) => item.key === key),
    );
    const passed = scores.filter((item) => item.score === 1).length;
    return { passed, total: scores.length, failed: scores.length - passed };
  };

  console.log('\n=== Evaluation complete ===');
  for (const [label, key] of [
    ['Route correctness', 'route_correct'],
    ['Mode correctness', 'mode_correct'],
    ['Phase correctness', 'phase_correct'],
    ['Capability-state correctness', 'capability_state_correct'],
    ['Active-capability correctness', 'active_capability_correct'],
    ['Capability-candidates correctness', 'capability_candidates_correct'],
    ['Capability-search-query correctness', 'capability_search_query_correct'],
  ] as const) {
    const score = summarizeScore(key);
    console.log(`${label}: ${score.passed}/${score.total} passed, ${score.failed} failed.`);
  }
  for (const row of rows) {
    const failedScores = row.evaluationResults.results.filter((item) =>
      [
        'route_correct',
        'mode_correct',
        'phase_correct',
        'capability_state_correct',
        'active_capability_correct',
        'capability_candidates_correct',
        'capability_search_query_correct',
      ].includes(item.key)
      && item.score !== 1,
    );
    if (failedScores.length === 0) continue;
    const name = row.example.metadata?.name ?? row.example.id;
    const outputRoute = row.run.outputs?.route ?? '(missing)';
    const outputMode = row.run.outputs?.mode ?? '(missing)';
    const expectedRoute = row.example.outputs?.expected_route ?? '(missing)';
    const expectedMode = row.example.outputs?.expected_mode ?? '(none)';
    console.log(`  - ${name}: expected route ${expectedRoute}, got ${outputRoute}; expected mode ${expectedMode}, got ${outputMode}. ${failedScores.map((item) => item.comment).join(' | ')}`);
  }
  console.log('View results in LangSmith dashboard.');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(console.error);
}
