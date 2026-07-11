/**
 * Task decision stability eval.
 *
 * Runs the production taskDecision prompt + schema directly across several
 * input shapes and repeats each case to surface output drift.
 *
 * Env:
 *   LLM_API_KEY                    Provider API key. Falls back to ~/.pinpawo/config.json llm_api_key.
 *   LLM_BASE_URL                   Provider base URL. Falls back to ~/.pinpawo/config.json llm_base_url.
 *   LLM_MODEL                      Model name. Falls back to ~/.pinpawo/config.json llm_model.
 *   DECISION_STRUCTURED_OUTPUT_METHOD Optional method override: functionCalling,jsonMode,jsonSchema.
 *   DECISION_STRUCTURED_OUTPUT_STRICT Optional true/false. Not used for jsonMode.
 *   TASK_DECISION_CASES            Comma-separated case ids. Defaults to all.
 *   TASK_DECISION_REPEATS          Repetitions per case. Default 3.
 *   TASK_DECISION_TIMEOUT_MS       Per-call timeout. Default 120000.
 *
 * Run:
 *   npm run eval:task-decision -w @pinpawo/pet-agent
 */
import { AIMessage, HumanMessage, SystemMessage, type BaseMessage } from '@langchain/core/messages';
import { ChatOpenAI } from '@langchain/openai';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import {
  buildRunDelegationSummaryContext,
  buildRuntimeContext,
  buildTaskDecisionInput,
  buildTaskDecisionSystemPrompt,
} from '../src/agent/orchestrator/prompts';
import {
  buildOrchestrationDecisionStructuredOutputOptions,
  buildTaskDecisionOutputInstruction,
  buildTaskDecisionSchema,
  type TaskDecision,
} from '../src/agent/orchestrator/schemas';
import type { RunDelegationSummary } from '../src/agent/orchestrator/types';
import type { AgentActor } from '../src/types/agent';
import { entryDecisionBasicsDataset } from './datasets/entry-decision-basics.ts';
import { adaptTaskDecisionMode } from './decision-contract-scorers.ts';
import {
  inferStructuredOutputMethod,
  type StructuredOutputMethod,
} from '../src/utils/structuredOutput';

type EvalCase = {
  id: string;
  name: string;
  latestUserRequest: string;
  recentMessages?: BaseMessage[];
  runDelegationSummaries?: RunDelegationSummary[];
  expectedAction?: TaskDecision['action'];
  targetMode: 'answer' | 'direct_task' | 'needs_plan';
  expectedTaskPattern?: RegExp;
  forbiddenTaskPattern?: RegExp;
};

type EvalResult = {
  caseId: string;
  repeat: number;
  ok: boolean;
  schemaOk: boolean;
  durationMs: number;
  action: string | null;
  taskPreview: string | null;
  issues: string[];
  errorType: string | null;
  errorMessage: string | null;
};

const DEFAULT_BASE_URL = 'https://dashscope.aliyuncs.com/compatible-mode/v1';
const DEFAULT_MODEL = 'qwen3.5-plus';
const DEFAULT_REPEATS = 3;
const DEFAULT_TIMEOUT_MS = 120_000;

const evalActor: AgentActor = {
  petId: 'eval-pet',
  userId: 'eval-user',
  name: 'task-decision-eval',
  personality: null,
  stage: null,
  species: null,
};

function completedSummary(
  id: string,
  task: string,
  resultPreview: string,
  lane: RunDelegationSummary['lane'] = 'capability:explore',
): RunDelegationSummary {
  return {
    id,
    lane,
    task,
    status: 'completed',
    resultPreview,
  };
}

function termsPattern(terms: string[] | undefined): RegExp | undefined {
  if (!terms?.length) return undefined;
  return new RegExp(terms.map((term) => term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'i');
}

const entryCases: EvalCase[] = entryDecisionBasicsDataset.cases.map((testCase) => ({
  id: testCase.id,
  name: testCase.name,
  latestUserRequest: testCase.input.userRequest,
  recentMessages: testCase.input.conversationContext?.map((text) => new AIMessage(text)),
  expectedAction: testCase.expected.mode,
  targetMode: testCase.expected.mode,
  expectedTaskPattern: termsPattern(testCase.expected.expectedTaskTerms),
}));

const EVAL_CASES: EvalCase[] = [
  ...entryCases,
  {
    id: 'initial-pr-review-keywords',
    name: 'PR review stays one deliverable and keeps investigation keywords',
    latestUserRequest: 'review https://github.com/pinpawo/pinpawo-agent/pull/344，重点看 Stage B 的 task routing 有没有回归。',
    expectedAction: 'direct_task',
    targetMode: 'direct_task',
    expectedTaskPattern: /review|PR|344|Stage B|routing|回归/i,
  },
  {
    id: 'after-first-handoff-next-task',
    name: 'completed handoff informs the next current task',
    latestUserRequest: '看 issue #269，再查本地实现，最后总结。',
    runDelegationSummaries: [
      completedSummary(
        'task-1',
        '读取 issue #269 并提炼需求点。',
        'issue #269 要求检查本地实现是否已经覆盖 Stage B 的任务边界设计。',
      ),
    ],
    expectedAction: 'direct_task',
    targetMode: 'direct_task',
    expectedTaskPattern: /本地|实现|git|log|检索|检查/i,
    forbiddenTaskPattern: /读取 issue|提炼需求点/i,
  },
  {
    id: 'after-first-handoff-remaining-work',
    name: 'remaining work fits one task and does not create answer-work guidance',
    latestUserRequest: '看 issue #269，再查本地实现和 git log，最后总结是否已经覆盖。',
    runDelegationSummaries: [
      completedSummary(
        'task-1',
        '读取 issue #269 并提炼需求点。',
        '已拿到 issue 诉求，接下来仍需检查本地实现和 git log。',
      ),
    ],
    expectedAction: 'direct_task',
    targetMode: 'direct_task',
    expectedTaskPattern: /本地|实现|git|log|检索|检查/i,
  },
  {
    id: 'completed-goal-answer',
    name: 'completed task summaries can end at answer',
    latestUserRequest: '看 issue #269，再查本地实现，最后总结。',
    runDelegationSummaries: [
      completedSummary(
        'task-1',
        '读取 issue #269 并提炼需求点。',
        'issue #269 的诉求是拆分 planning 和 verdict。',
      ),
      completedSummary(
        'task-2',
        '检索本地实现与 git log，判断需求点是否已覆盖。',
        '本地实现已经把 outcomeDecision 验收化，并让 task_done 回环 taskDecision。',
      ),
    ],
    expectedAction: 'answer',
    targetMode: 'answer',
  },
];

function loadPinpawoConfig(): Record<string, string> {
  try {
    return JSON.parse(readFileSync(resolve(homedir(), '.pinpawo', 'config.json'), 'utf8'));
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

function splitList(value: string | undefined): string[] {
  return (value ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function parseOptionalBoolean(name: string): boolean | undefined {
  const raw = process.env[name]?.trim().toLowerCase();
  if (!raw) return undefined;
  if (['1', 'true', 'yes', 'y', 'on'].includes(raw)) return true;
  if (['0', 'false', 'no', 'n', 'off'].includes(raw)) return false;
  throw new Error(`Invalid ${name}: ${process.env[name]}`);
}

function normalizeStructuredOutputMethod(value: string | undefined): StructuredOutputMethod | undefined {
  if (!value) return undefined;
  if (value === 'functionCalling' || value === 'jsonMode' || value === 'jsonSchema') {
    return value;
  }
  throw new Error(
    `Invalid DECISION_STRUCTURED_OUTPUT_METHOD: ${value}. ` +
    'Use functionCalling, jsonMode, or jsonSchema.',
  );
}

function buildModelKwargs(model: string) {
  const normalized = model.toLowerCase();
  if (
    normalized.includes('qwen')
    || normalized.includes('glm')
    || normalized.includes('minimax')
  ) {
    return { extra_body: { enable_thinking: false } };
  }
  if (normalized.includes('deepseek')) {
    return { thinking: { type: 'disabled' } };
  }
  return undefined;
}

function requiresStreaming(model: string): boolean {
  return model.toLowerCase().includes('glm-4.5');
}

function buildModel(params: {
  apiKey: string;
  baseUrl: string;
  model: string;
  timeoutMs: number;
}) {
  return new ChatOpenAI({
    model: params.model,
    temperature: 0,
    timeout: params.timeoutMs,
    maxRetries: 0,
    apiKey: params.apiKey,
    streaming: requiresStreaming(params.model),
    modelKwargs: buildModelKwargs(params.model),
    configuration: {
      baseURL: params.baseUrl,
      defaultHeaders: { Authorization: `Bearer ${params.apiKey}` },
    },
  });
}

function resolveApiKey(
  pinpawoConfig: Record<string, string>,
  pinpawoEnv: Record<string, string>,
): {
  apiKey: string | undefined;
  source: 'LLM_API_KEY' | '~/.pinpawo/.env' | '~/.pinpawo/config.json' | 'missing';
} {
  if (process.env.LLM_API_KEY) {
    return { apiKey: process.env.LLM_API_KEY, source: 'LLM_API_KEY' };
  }
  if (pinpawoEnv.LLM_API_KEY) {
    return { apiKey: pinpawoEnv.LLM_API_KEY, source: '~/.pinpawo/.env' };
  }
  if (pinpawoConfig.llm_api_key) {
    return { apiKey: pinpawoConfig.llm_api_key, source: '~/.pinpawo/config.json' };
  }
  return { apiKey: undefined, source: 'missing' };
}

function redactSecret(value: string | undefined): string {
  if (!value) return '(missing)';
  if (value.length <= 10) return `${value.slice(0, 2)}...${value.slice(-2)}`;
  return `${value.slice(0, 6)}...${value.slice(-4)}`;
}

function compactError(error: unknown): { type: string; message: string } {
  if (error instanceof Error) {
    const maybeStatus = (error as Error & { status?: unknown; code?: unknown }).status
      ?? (error as Error & { status?: unknown; code?: unknown }).code;
    const status = maybeStatus == null ? '' : `${maybeStatus}:`;
    return {
      type: error.name || 'Error',
      message: `${status}${error.message}`.slice(0, 500),
    };
  }
  return { type: typeof error, message: String(error).slice(0, 500) };
}

function preview(value: string | null | undefined, maxLength = 90): string | null {
  if (!value) return null;
  return value.replace(/\s+/g, ' ').slice(0, maxLength);
}

function hasMultiStepShape(task: string | null | undefined): boolean {
  if (!task) return false;
  return (
    /(?:^|\n)\s*(?:\d+[.、)]|[-*])\s+\S/.test(task)
    || task.length > 220
  );
}

function evaluateDecision(testCase: EvalCase, decision: TaskDecision): string[] {
  const issues: string[] = [];
  const task = typeof decision.task === 'string' ? decision.task.trim() : null;

  if (testCase.expectedAction && decision.action !== testCase.expectedAction) {
    issues.push(`expected action=${testCase.expectedAction}, got ${decision.action}`);
  }
  const adaptedMode = adaptTaskDecisionMode(decision.action);
  if (adaptedMode !== testCase.targetMode) {
    issues.push(`target mode=${testCase.targetMode}, current adapter produced ${adaptedMode}`);
  }
  if (decision.action === 'answer') {
    if (task) issues.push('answer action should not include task text');
  }
  if (decision.action === 'direct_task') {
    if (!task) issues.push(`${decision.action} action requires task`);
    if (hasMultiStepShape(task)) {
      issues.push('task appears to contain an enumerated plan or is oversized');
    }
  }
  if (task && testCase.expectedTaskPattern && !testCase.expectedTaskPattern.test(task)) {
    issues.push(`task does not match ${testCase.expectedTaskPattern.toString()}`);
  }
  if (task && testCase.forbiddenTaskPattern && testCase.forbiddenTaskPattern.test(task)) {
    issues.push(`task matches forbidden pattern ${testCase.forbiddenTaskPattern.toString()}`);
  }

  return issues;
}

function selectCases(): EvalCase[] {
  const requested = splitList(process.env.TASK_DECISION_CASES);
  if (requested.length === 0) return EVAL_CASES;
  const byId = new Map(EVAL_CASES.map((testCase) => [testCase.id, testCase]));
  return requested.map((id) => {
    const testCase = byId.get(id);
    if (!testCase) {
      throw new Error(
        `Invalid TASK_DECISION_CASES item: ${id}. ` +
        `Use one of: ${EVAL_CASES.map((item) => item.id).join(', ')}.`,
      );
    }
    return testCase;
  });
}

async function runOne(params: {
  chatModel: ChatOpenAI;
  method: StructuredOutputMethod | undefined;
  strict: boolean | undefined;
  testCase: EvalCase;
  repeat: number;
}): Promise<EvalResult> {
  const started = performance.now();
  try {
    const systemPrompt = buildTaskDecisionSystemPrompt({
      actor: evalActor,
      outputInstruction: buildTaskDecisionOutputInstruction(params.method),
    });
    const input = buildTaskDecisionInput({
      latestUserRequest: params.testCase.latestUserRequest,
      recentMessages: params.testCase.recentMessages ?? [new HumanMessage(params.testCase.latestUserRequest)],
      runDelegationContext: buildRunDelegationSummaryContext(params.testCase.runDelegationSummaries ?? []),
      runtimeContext: buildRuntimeContext(process.cwd(), process.version),
    });
    const structuredModel = params.chatModel.withStructuredOutput(
      buildTaskDecisionSchema(),
      buildOrchestrationDecisionStructuredOutputOptions({
        method: params.method,
        strict: params.method !== 'jsonMode' ? params.strict : undefined,
      }),
    );
    const raw = await structuredModel.invoke([
      new SystemMessage(systemPrompt),
      new HumanMessage(input),
    ]);
    const parsed = buildTaskDecisionSchema().safeParse(raw);
    if (!parsed.success) {
      return {
        caseId: params.testCase.id,
        repeat: params.repeat,
        ok: false,
        schemaOk: false,
        durationMs: Math.round(performance.now() - started),
        action: null,
        taskPreview: null,
        issues: ['schema validation failed'],
        errorType: 'ZodError',
        errorMessage: parsed.error.message.slice(0, 500),
      };
    }
    const issues = evaluateDecision(params.testCase, parsed.data);
    return {
      caseId: params.testCase.id,
      repeat: params.repeat,
      ok: issues.length === 0,
      schemaOk: true,
      durationMs: Math.round(performance.now() - started),
      action: parsed.data.action,
      taskPreview: preview(parsed.data.task),
      issues,
      errorType: null,
      errorMessage: null,
    };
  } catch (error) {
    const compact = compactError(error);
    return {
      caseId: params.testCase.id,
      repeat: params.repeat,
      ok: false,
      schemaOk: false,
      durationMs: Math.round(performance.now() - started),
      action: null,
      taskPreview: null,
      issues: ['invoke failed'],
      errorType: compact.type,
      errorMessage: compact.message,
    };
  }
}

function formatDistribution(values: Array<string | number | null>): string {
  const counts = new Map<string, number>();
  for (const value of values) {
    const key = value == null ? 'null' : String(value);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([key, count]) => `${key}:${count}`)
    .join(', ');
}

function printSummary(results: EvalResult[], repeats: number) {
  console.table(results.map((result) => ({
    case: result.caseId,
    rep: result.repeat,
    ok: result.ok ? 'ok' : 'fail',
    action: result.action ?? '',
    ms: result.durationMs,
    task: result.taskPreview ?? '',
    issues: result.issues.join('; '),
    error: result.errorMessage ? `${result.errorType}: ${result.errorMessage}` : '',
  })));

  console.log('\nTask decision stability summary:');
  const caseIds = [...new Set(results.map((result) => result.caseId))];
  for (const caseId of caseIds) {
    const group = results.filter((result) => result.caseId === caseId);
    const pass = group.filter((result) => result.ok).length;
    console.log(
      `- ${caseId}: ${pass}/${repeats} passed; ` +
      `target=${EVAL_CASES.find((item) => item.id === caseId)?.targetMode}; ` +
      `actions=[${formatDistribution(group.map((item) => item.action))}]; ` +
      `tasks=[${formatDistribution(group.map((item) => item.taskPreview))}]`,
    );
  }
}

async function main() {
  const pinpawoConfig = loadPinpawoConfig();
  const pinpawoEnv = loadPinpawoEnv();
  const { apiKey, source: apiKeySource } = resolveApiKey(pinpawoConfig, pinpawoEnv);
  const baseUrl = process.env.LLM_BASE_URL
    || pinpawoEnv.LLM_BASE_URL
    || pinpawoConfig.llm_base_url
    || DEFAULT_BASE_URL;
  const model = process.env.LLM_MODEL
    || pinpawoEnv.LLM_MODEL
    || pinpawoConfig.llm_model
    || DEFAULT_MODEL;
  const method = normalizeStructuredOutputMethod(process.env.DECISION_STRUCTURED_OUTPUT_METHOD)
    ?? inferStructuredOutputMethod(model, baseUrl);
  const strict = parseOptionalBoolean('DECISION_STRUCTURED_OUTPUT_STRICT');
  const timeoutMs = Number(process.env.TASK_DECISION_TIMEOUT_MS ?? DEFAULT_TIMEOUT_MS);
  const repeats = Number(process.env.TASK_DECISION_REPEATS ?? DEFAULT_REPEATS);
  const cases = selectCases();

  if (!apiKey) {
    throw new Error('Missing LLM_API_KEY, ~/.pinpawo/.env LLM_API_KEY, or ~/.pinpawo/config.json llm_api_key.');
  }
  if (!Number.isInteger(repeats) || repeats <= 0) {
    throw new Error(`Invalid TASK_DECISION_REPEATS: ${process.env.TASK_DECISION_REPEATS}`);
  }
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error(`Invalid TASK_DECISION_TIMEOUT_MS: ${process.env.TASK_DECISION_TIMEOUT_MS}`);
  }

  console.log('Task decision stability eval');
  console.log(`Base URL: ${baseUrl}`);
  console.log(`API key: ${redactSecret(apiKey)} (${apiKeySource})`);
  console.log(`Model: ${model}`);
  console.log(`Structured output method: ${method ?? 'default'}`);
  if (typeof strict === 'boolean') console.log(`Strict: ${strict}`);
  console.log(`Repeats: ${repeats}`);
  console.log(`Cases: ${cases.map((item) => item.id).join(', ')}`);
  console.log('');

  const chatModel = buildModel({
    apiKey,
    baseUrl,
    model,
    timeoutMs,
  });
  const results: EvalResult[] = [];

  for (const testCase of cases) {
    for (let repeat = 1; repeat <= repeats; repeat += 1) {
      const result = await runOne({
        chatModel,
        method,
        strict,
        testCase,
        repeat,
      });
      results.push(result);
      const marker = result.ok ? 'PASS' : 'FAIL';
      console.log(
        `[${marker}] case=${testCase.id} repeat=${repeat} ` +
        `action=${result.action ?? 'n/a'} ` +
        `durationMs=${result.durationMs}` +
        (result.issues.length > 0 ? ` issues=${result.issues.join('; ')}` : '') +
        (result.errorMessage ? ` error=${result.errorType}: ${result.errorMessage}` : ''),
      );
    }
  }

  console.log('');
  printSummary(results, repeats);

  const failed = results.filter((result) => !result.ok);
  if (failed.length > 0) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  const compact = compactError(error);
  console.error(`${compact.type}: ${compact.message}`);
  process.exitCode = 1;
});
