/**
 * Entry decision result-availability stability eval.
 *
 * Runs the production entryDecision prompt + schema directly across several
 * input shapes and repeats each case to surface output drift.
 *
 * Env:
 *   LLM_API_KEY                    Provider API key. Falls back to ~/.pinpawo/config.json llm_api_key.
 *   LLM_BASE_URL                   Provider base URL. Falls back to ~/.pinpawo/config.json llm_base_url.
 *   LLM_MODEL                      Model name. Falls back to ~/.pinpawo/config.json llm_model.
 *   DECISION_STRUCTURED_OUTPUT_METHOD Optional method override: functionCalling,jsonMode,jsonSchema.
 *   DECISION_STRUCTURED_OUTPUT_STRICT Optional true/false. Not used for jsonMode.
 *   ENTRY_DECISION_PROTOCOL         json (default) or routeFunctions. routeFunctions exercises
 *                                   the production required route-function adapter.
 *   ENTRY_DECISION_CASES            Comma-separated case ids. Defaults to all.
 *   ENTRY_DECISION_REPEATS          Repetitions per case. Default 3.
 *   ENTRY_DECISION_TIMEOUT_MS       Per-call timeout. Default 120000.
 *
 * Run:
 *   npm run eval:entry-decision -w @pinpawo/pet-agent
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
  buildEntryDecisionInput,
  buildEntryDecisionSystemPrompt,
} from '../src/agent/orchestrator/prompts';
import {
  buildEntryDecisionOutputInstruction,
  type EntryDecision,
} from '../src/agent/orchestrator/schemas';
import {
  buildRouteFunctionEntryDecisionBriefingInstruction,
  buildRouteFunctionEntryDecisionInstruction,
  invokeEntryDecisionOutcome,
} from '../src/agent/orchestrator/runtime/decisions/entryDecisionProtocol.ts';
import type { AgentActor } from '../src/types/agent';
import { entryDecisionBasicsDataset } from './datasets/entry-decision-basics.ts';
import {
  inferStructuredOutputMethod,
  type StructuredOutputMethod,
} from '../src/utils/structuredOutput';

type EvalCase = {
  id: string;
  name: string;
  latestUserRequest: string;
  recentMessages?: BaseMessage[];
  expectedAction: EntryDecision['action'];
};

type EvalResult = {
  caseId: string;
  repeat: number;
  ok: boolean;
  schemaOk: boolean;
  durationMs: number;
  action: string | null;
  issues: string[];
  errorType: string | null;
  errorMessage: string | null;
};

type EntryDecisionProtocol = 'json' | 'routeFunctions';

const DEFAULT_BASE_URL = 'https://dashscope.aliyuncs.com/compatible-mode/v1';
const DEFAULT_MODEL = 'qwen3.5-plus';
const DEFAULT_REPEATS = 3;
const DEFAULT_TIMEOUT_MS = 120_000;

const evalActor: AgentActor = {
  petId: 'eval-pet',
  userId: 'eval-user',
  name: 'entry-decision-eval',
  personality: null,
  stage: null,
  species: null,
};

const entryCases: EvalCase[] = entryDecisionBasicsDataset.cases.map((testCase) => ({
  id: testCase.id,
  name: testCase.name,
  latestUserRequest: testCase.input.userRequest,
  recentMessages: testCase.input.conversationMessages?.map((message) =>
    message.role === 'user'
      ? new HumanMessage(message.content)
      : new AIMessage(message.content),
  ) ?? testCase.input.conversationContext?.map((text) => new AIMessage(text)),
  expectedAction: testCase.expected.mode,
}));

const EVAL_CASES: EvalCase[] = entryCases;

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

function normalizeEntryDecisionProtocol(value: string | undefined): EntryDecisionProtocol {
  if (!value || value === 'json') return 'json';
  if (value === 'routeFunctions') return value;
  throw new Error(
    `Invalid ENTRY_DECISION_PROTOCOL: ${value}. Use json or routeFunctions.`,
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

function evaluateDecision(testCase: EvalCase, decision: EntryDecision): string[] {
  const issues: string[] = [];
  if (decision.action !== testCase.expectedAction) {
    issues.push(`expected action=${testCase.expectedAction}, got ${decision.action}`);
  }
  return issues;
}

function selectCases(): EvalCase[] {
  const requested = splitList(process.env.ENTRY_DECISION_CASES);
  if (requested.length === 0) return EVAL_CASES;
  const byId = new Map(EVAL_CASES.map((testCase) => [testCase.id, testCase]));
  return requested.map((id) => {
    const testCase = byId.get(id);
    if (!testCase) {
      throw new Error(
        `Invalid ENTRY_DECISION_CASES item: ${id}. ` +
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
  protocol: EntryDecisionProtocol;
  testCase: EvalCase;
  repeat: number;
}): Promise<EvalResult> {
  const started = performance.now();
  try {
    const systemPrompt = buildEntryDecisionSystemPrompt({
      actor: evalActor,
      ...(params.protocol === 'routeFunctions'
        ? {
            briefingInstruction: buildRouteFunctionEntryDecisionBriefingInstruction(),
            outputInstruction: buildRouteFunctionEntryDecisionInstruction(),
          }
        : {
            outputInstruction: buildEntryDecisionOutputInstruction(params.method),
          }),
    });
    const input = buildEntryDecisionInput({
      runDelegationContext: buildRunDelegationSummaryContext([]),
      runtimeContext: buildRuntimeContext(process.cwd(), process.version),
    });
    const outcome = await invokeEntryDecisionOutcome({
      config: {
        models: { act: params.chatModel },
        decisionStructuredOutput: {
          ...(params.method ? { method: params.method } : {}),
          ...(params.method !== 'jsonMode' && typeof params.strict === 'boolean'
            ? { strict: params.strict }
            : {}),
          ...(params.protocol === 'routeFunctions'
            ? { entryDecisionProtocol: params.protocol }
            : {}),
        },
      },
      messages: [
        new SystemMessage(systemPrompt),
        new HumanMessage(input),
        ...(params.testCase.recentMessages ?? []),
        new HumanMessage(params.testCase.latestUserRequest),
      ],
    });
    const decision: EntryDecision = outcome.kind === 'answer'
      ? { action: 'answer', planner_objective: null, planner_context: null }
      : {
          action: 'needs_plan',
          planner_objective: outcome.briefing.objective,
          planner_context: outcome.briefing.context,
        };
    const issues = evaluateDecision(params.testCase, decision);
    return {
      caseId: params.testCase.id,
      repeat: params.repeat,
      ok: issues.length === 0,
      schemaOk: true,
      durationMs: Math.round(performance.now() - started),
      action: decision.action,
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
    issues: result.issues.join('; '),
    error: result.errorMessage ? `${result.errorType}: ${result.errorMessage}` : '',
  })));

  console.log('\nEntry decision stability summary:');
  const caseIds = [...new Set(results.map((result) => result.caseId))];
  for (const caseId of caseIds) {
    const group = results.filter((result) => result.caseId === caseId);
    const pass = group.filter((result) => result.ok).length;
    console.log(
      `- ${caseId}: ${pass}/${repeats} passed; ` +
      `target=${EVAL_CASES.find((item) => item.id === caseId)?.expectedAction}; ` +
      `actions=[${formatDistribution(group.map((item) => item.action))}]`,
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
  const protocol = normalizeEntryDecisionProtocol(process.env.ENTRY_DECISION_PROTOCOL);
  const strict = parseOptionalBoolean('DECISION_STRUCTURED_OUTPUT_STRICT');
  const timeoutMs = Number(process.env.ENTRY_DECISION_TIMEOUT_MS ?? DEFAULT_TIMEOUT_MS);
  const repeats = Number(process.env.ENTRY_DECISION_REPEATS ?? DEFAULT_REPEATS);
  const cases = selectCases();

  if (!apiKey) {
    throw new Error('Missing LLM_API_KEY, ~/.pinpawo/.env LLM_API_KEY, or ~/.pinpawo/config.json llm_api_key.');
  }
  if (!Number.isInteger(repeats) || repeats <= 0) {
    throw new Error(`Invalid ENTRY_DECISION_REPEATS: ${process.env.ENTRY_DECISION_REPEATS}`);
  }
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error(`Invalid ENTRY_DECISION_TIMEOUT_MS: ${process.env.ENTRY_DECISION_TIMEOUT_MS}`);
  }
  if (protocol === 'routeFunctions' && method !== 'functionCalling') {
    throw new Error('ENTRY_DECISION_PROTOCOL=routeFunctions requires DECISION_STRUCTURED_OUTPUT_METHOD=functionCalling.');
  }

  console.log('Entry decision stability eval');
  console.log(`Base URL: ${baseUrl}`);
  console.log(`API key: ${redactSecret(apiKey)} (${apiKeySource})`);
  console.log(`Model: ${model}`);
  console.log(`Structured output method: ${method ?? 'default'}`);
  console.log(`Entry decision protocol: ${protocol}`);
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
        protocol,
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
