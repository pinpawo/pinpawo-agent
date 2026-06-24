/**
 * Structured output compatibility smoke eval.
 *
 * This is intentionally standalone rather than a LangSmith eval: it is meant to
 * answer "which structured output method works for this provider/model now?"
 * before running heavier business-route evals.
 *
 * Env:
 *   LLM_API_KEY                  Provider API key. Falls back to ~/.pinpawo/config.json llm_api_key.
 *   LLM_BASE_URL                 Provider base URL. Falls back to ~/.pinpawo/config.json llm_base_url.
 *   LLM_MODELS                   Comma-separated models to test. Falls back to LLM_MODEL/config model.
 *   LLM_MODEL                    Single model fallback.
 *   STRUCTURED_OUTPUT_METHODS    Comma-separated methods: functionCalling,jsonMode,jsonSchema, or auto.
 *   STRUCTURED_OUTPUT_STRICT     Optional true/false. Not used for jsonMode.
 *   STRUCTURED_OUTPUT_CASES      Comma-separated case ids. Defaults to all.
 *   STRUCTURED_OUTPUT_TIMEOUT_MS Per-call timeout. Default 120000.
 *
 * Run:
 *   npm run eval:structured-output -w @pinpawo/pet-agent
 *   LLM_MODELS=qwen3.5-plus,glm-5,kimi-k2.6,MiniMax-M2.6 npm run eval:structured-output -w @pinpawo/pet-agent
 */
import { ChatOpenAI } from '@langchain/openai';
import { HumanMessage, SystemMessage } from '@langchain/core/messages';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { z } from 'zod';
import {
  inferStructuredOutputMethod,
  type StructuredOutputMethod,
} from '../src/utils/structuredOutput';

type EvalCase = {
  id: string;
  name: string;
  schema: z.ZodTypeAny;
  prompt: string;
};

type EvalResult = {
  model: string;
  method: StructuredOutputMethod;
  caseId: string;
  ok: boolean;
  schemaOk: boolean;
  durationMs: number;
  errorType: string | null;
  errorMessage: string | null;
  outputPreview: string | null;
};

const DEFAULT_BASE_URL = 'https://dashscope.aliyuncs.com/compatible-mode/v1';
const DEFAULT_MODEL = 'qwen3.5-plus';
const DEFAULT_METHODS: StructuredOutputMethod[] = ['functionCalling', 'jsonMode', 'jsonSchema'];

const orchestrationDecisionSchema = z.object({
  action: z.enum(['answer', 'delegate_general', 'delegate_capability.explore']),
  task: z.string().nullable().optional(),
  context_summary: z.string().nullable().optional(),
});

const exploreIngestSchema = z.object({
  summary: z.string().min(1),
  evidence: z.array(z.object({
    source: z.string().min(1),
    proves: z.string().min(1),
    value: z.string().min(1),
  })),
});

const wikiCuratorSchema = z.object({
  topicUpdates: z.array(z.object({
    filename: z.string().min(1),
    content: z.string().min(1),
  })),
  indexContent: z.string().min(1),
});

const EVAL_CASES: EvalCase[] = [
  {
    id: 'decision',
    name: 'orchestrator decision shape',
    schema: orchestrationDecisionSchema,
    prompt: [
      '根据用户请求生成一个 orchestration decision JSON。',
      '必须严格使用字段 action、task、context_summary。',
      '不要输出 delegate_capability 作为字段名；如果要委派 explore，必须输出 "action": "delegate_capability.explore"。',
      '用户请求：请检查当前项目为什么 typecheck 失败，并修复问题。',
      '可选 capability：explore。',
      '应选择 delegate_capability.explore，并给出明确 task 和 context_summary。',
      '正确示例：{"action":"delegate_capability.explore","task":"检查 typecheck 失败原因并修复。","context_summary":"用户要求定位并修复当前项目 typecheck 失败。"}',
    ].join('\n'),
  },
  {
    id: 'explore_ingest',
    name: 'explore ingest nested evidence shape',
    schema: exploreIngestSchema,
    prompt: [
      '把以下探索证据总结为 Markdown summary，并给出 evidence 数组 JSON。',
      '证据：services/local-agent/src/agentChannel.ts 的 auto 策略按模型官方文档优先选择结构化输出方式；',
      'GLM、DeepSeek 和 Qwen 主要使用 JSON Mode，并由下游做 JSON Schema 校验。',
    ].join('\n'),
  },
  {
    id: 'wiki_curator',
    name: 'wiki curator array/update shape',
    schema: wikiCuratorSchema,
    prompt: [
      '根据素材生成 wiki 更新 JSON。',
      '素材：PinPawo local agent 支持通过百炼兼容 OpenAI endpoint 调用模型；',
      '当前策略会按模型族选择 structured output method。',
      '输出一个 topicUpdates 条目，filename 使用 structured-output.md，并生成 indexContent。',
    ].join('\n'),
  },
];

function loadPinpawoConfig(): Record<string, string> {
  try {
    return JSON.parse(readFileSync(resolve(homedir(), '.pinpawo', 'config.json'), 'utf8'));
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

function parseMethods(value: string | undefined): StructuredOutputMethod[] {
  const rawMethods = splitList(value);
  if (rawMethods.length === 0) return DEFAULT_METHODS;
  if (rawMethods.length === 1 && rawMethods[0] === 'auto') return [];
  return rawMethods.map((method) => {
    if (method === 'functionCalling' || method === 'jsonMode' || method === 'jsonSchema') {
      return method;
    }
    throw new Error(
      `Invalid STRUCTURED_OUTPUT_METHODS item: ${method}. ` +
      'Use functionCalling, jsonMode, jsonSchema, or auto.',
    );
  });
}

function parseOptionalBoolean(name: string): boolean | undefined {
  const raw = process.env[name]?.trim().toLowerCase();
  if (!raw) return undefined;
  if (['1', 'true', 'yes', 'y', 'on'].includes(raw)) return true;
  if (['0', 'false', 'no', 'n', 'off'].includes(raw)) return false;
  throw new Error(`Invalid ${name}: ${process.env[name]}`);
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
  const normalized = model.toLowerCase();
  return normalized.includes('glm-4.5');
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

function preview(value: unknown): string {
  return (JSON.stringify(value) ?? String(value))
    .replace(/\s+/g, ' ')
    .slice(0, 180);
}

function resolveApiKey(pinpawoConfig: Record<string, string>): {
  apiKey: string | undefined;
  source: 'LLM_API_KEY' | '~/.pinpawo/config.json' | 'missing';
} {
  if (process.env.LLM_API_KEY) {
    return { apiKey: process.env.LLM_API_KEY, source: 'LLM_API_KEY' };
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

async function runOne(params: {
  apiKey: string;
  baseUrl: string;
  timeoutMs: number;
  strict: boolean | undefined;
  model: string;
  method: StructuredOutputMethod;
  testCase: EvalCase;
}): Promise<EvalResult> {
  const started = performance.now();
  try {
    const chatModel = buildModel({
      apiKey: params.apiKey,
      baseUrl: params.baseUrl,
      model: params.model,
      timeoutMs: params.timeoutMs,
    });
    const structuredModel = chatModel.withStructuredOutput(params.testCase.schema, {
      name: `pinpawo_${params.testCase.id}`,
      method: params.method,
      ...(params.method !== 'jsonMode' && typeof params.strict === 'boolean'
        ? { strict: params.strict }
        : {}),
    });
    const result = await structuredModel.invoke([
      new SystemMessage([
        '你是 PinPawo structured output compatibility eval。',
        '必须只返回符合 schema 的 JSON 语义内容，不要添加解释。',
        'JSON 字段必须满足调用方提供的 schema。',
      ].join('\n')),
      new HumanMessage(params.testCase.prompt),
    ]);
    const schemaResult = params.testCase.schema.safeParse(result);
    return {
      model: params.model,
      method: params.method,
      caseId: params.testCase.id,
      ok: schemaResult.success,
      schemaOk: schemaResult.success,
      durationMs: Math.round(performance.now() - started),
      errorType: schemaResult.success ? null : 'ZodError',
      errorMessage: schemaResult.success ? null : schemaResult.error.message.slice(0, 500),
      outputPreview: preview(result),
    };
  } catch (error) {
    const compact = compactError(error);
    return {
      model: params.model,
      method: params.method,
      caseId: params.testCase.id,
      ok: false,
      schemaOk: false,
      durationMs: Math.round(performance.now() - started),
      errorType: compact.type,
      errorMessage: compact.message,
      outputPreview: null,
    };
  }
}

function selectCases(): EvalCase[] {
  const requested = splitList(process.env.STRUCTURED_OUTPUT_CASES);
  if (requested.length === 0) return EVAL_CASES;
  const byId = new Map(EVAL_CASES.map((testCase) => [testCase.id, testCase]));
  return requested.map((id) => {
    const testCase = byId.get(id);
    if (!testCase) {
      throw new Error(
        `Invalid STRUCTURED_OUTPUT_CASES item: ${id}. ` +
        `Use one of: ${EVAL_CASES.map((item) => item.id).join(', ')}.`,
      );
    }
    return testCase;
  });
}

function printSummary(results: EvalResult[]) {
  const rows = results.map((result) => ({
    model: result.model,
    method: result.method,
    case: result.caseId,
    ok: result.ok ? 'ok' : 'fail',
    ms: String(result.durationMs),
    error: result.errorMessage ? `${result.errorType}: ${result.errorMessage}` : '',
    preview: result.outputPreview ?? '',
  }));
  console.table(rows);

  const grouped = new Map<string, EvalResult[]>();
  for (const result of results) {
    const key = `${result.model} ${result.method}`;
    grouped.set(key, [...(grouped.get(key) ?? []), result]);
  }

  console.log('\nCompatibility summary:');
  for (const [key, group] of grouped) {
    const pass = group.filter((item) => item.ok).length;
    console.log(`- ${key}: ${pass}/${group.length} passed`);
  }
}

async function main() {
  const pinpawoConfig = loadPinpawoConfig();
  const { apiKey, source: apiKeySource } = resolveApiKey(pinpawoConfig);
  const baseUrl = process.env.LLM_BASE_URL || pinpawoConfig.llm_base_url || DEFAULT_BASE_URL;
  const models = splitList(process.env.LLM_MODELS);
  const modelList = models.length > 0
    ? models
    : [process.env.LLM_MODEL || pinpawoConfig.llm_model || DEFAULT_MODEL];
  const methods = parseMethods(process.env.STRUCTURED_OUTPUT_METHODS);
  const autoMethods = methods.length === 0;
  const strict = parseOptionalBoolean('STRUCTURED_OUTPUT_STRICT');
  const timeoutMs = Number(process.env.STRUCTURED_OUTPUT_TIMEOUT_MS ?? 120_000);
  const cases = selectCases();

  if (!apiKey) {
    throw new Error('Missing LLM_API_KEY or ~/.pinpawo/config.json llm_api_key.');
  }
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error(`Invalid STRUCTURED_OUTPUT_TIMEOUT_MS: ${process.env.STRUCTURED_OUTPUT_TIMEOUT_MS}`);
  }

  console.log('Structured output compatibility eval');
  console.log(`Base URL: ${baseUrl}`);
  console.log(`API key: ${redactSecret(apiKey)} (${apiKeySource})`);
  console.log(`Models: ${modelList.join(', ')}`);
  if (autoMethods) {
    console.log('Methods: auto');
    console.log(`Auto methods: ${modelList.map((model) => {
      const method = inferStructuredOutputMethod(model, baseUrl);
      return `${model}=${method ?? 'default'}`;
    }).join(', ')}`);
  } else {
    console.log(`Methods: ${methods.join(', ')}`);
  }
  console.log(`Cases: ${cases.map((item) => item.id).join(', ')}`);
  if (typeof strict === 'boolean') console.log(`Strict: ${strict}`);
  console.log('');

  const results: EvalResult[] = [];
  for (const model of modelList) {
    const modelMethods = autoMethods
      ? [inferStructuredOutputMethod(model, baseUrl)]
      : methods;
    for (const method of modelMethods) {
      if (!method) {
        console.log(`[SKIP] model=${model} method=default case=* reason=no explicit production strategy`);
        continue;
      }
      for (const testCase of cases) {
        const result = await runOne({
          apiKey,
          baseUrl,
          timeoutMs,
          strict,
          model,
          method,
          testCase,
        });
        results.push(result);
        const marker = result.ok ? 'PASS' : 'FAIL';
        console.log(
          `[${marker}] model=${model} method=${method} case=${testCase.id} ` +
          `durationMs=${result.durationMs}` +
          (result.errorMessage ? ` error=${result.errorType}: ${result.errorMessage}` : ''),
        );
      }
    }
  }

  console.log('');
  printSummary(results);

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
