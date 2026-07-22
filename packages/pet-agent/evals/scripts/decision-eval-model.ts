import { ChatOpenAI } from '@langchain/openai';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import type { AgentModels } from '../../src/types/agent.ts';
import type { StructuredOutputMethod } from '../../src/utils/structuredOutput.ts';
import { inferStructuredOutputMethod } from '../../src/utils/structuredOutput.ts';
import type { PromptEvalModelMetadata } from '../prompt-eval-report.ts';
import type { PromptEvalPricing } from '../prompt-eval-usage.ts';

function readStructuredOutputMethod(
  value: string | undefined,
): StructuredOutputMethod | undefined {
  if (!value) return undefined;
  if (value === 'functionCalling' || value === 'jsonMode' || value === 'jsonSchema') return value;
  throw new Error(`Invalid decision structured output method: ${value}`);
}

function loadConfig(): Record<string, string> {
  try {
    return JSON.parse(readFileSync(resolve(homedir(), '.pinpawo', 'config.json'), 'utf8'));
  } catch {
    return {};
  }
}

function loadEnv(): Record<string, string> {
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
      if ((value.startsWith('"') && value.endsWith('"'))
        || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      env[key] = value;
    }
    return env;
  } catch {
    return {};
  }
}

function readFiniteNumber(name: string, value: string | undefined, fallback?: number): number {
  if (value === undefined && fallback !== undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`Invalid ${name}: ${value ?? ''}`);
  }
  return parsed;
}

function sanitizeBaseUrl(value: string): string {
  try {
    const url = new URL(value);
    url.username = '';
    url.password = '';
    url.search = '';
    url.hash = '';
    return url.toString().replace(/\/$/, '');
  } catch {
    return value;
  }
}

function inferProvider(baseUrl: string): string {
  const host = (() => {
    try {
      return new URL(baseUrl).hostname;
    } catch {
      return baseUrl;
    }
  })();
  if (host.includes('aliyuncs.com')) return 'dashscope';
  if (host.includes('openai.com')) return 'openai';
  if (host.includes('openrouter.ai')) return 'openrouter';
  return host || 'unknown';
}

function inferModelFamily(model: string): string {
  const normalized = model.toLowerCase();
  const knownFamilies = ['qwen', 'gpt', 'o1', 'o3', 'o4', 'claude', 'gemini', 'deepseek', 'kimi', 'glm', 'minimax'];
  return knownFamilies.find((family) => normalized.includes(family))
    ?? normalized.split(/[-/:]/)[0]
    ?? 'unknown';
}

function readPricing(): PromptEvalPricing | null {
  const input = process.env.PROMPT_EVAL_INPUT_USD_PER_MILLION;
  const output = process.env.PROMPT_EVAL_OUTPUT_USD_PER_MILLION;
  if (input === undefined && output === undefined) return null;
  if (input === undefined || output === undefined) {
    throw new Error(
      'Set both PROMPT_EVAL_INPUT_USD_PER_MILLION and PROMPT_EVAL_OUTPUT_USD_PER_MILLION.',
    );
  }
  return {
    inputUsdPerMillionTokens: readFiniteNumber('PROMPT_EVAL_INPUT_USD_PER_MILLION', input),
    outputUsdPerMillionTokens: readFiniteNumber('PROMPT_EVAL_OUTPUT_USD_PER_MILLION', output),
  };
}

export function createDecisionEvalModel(): {
  model: AgentModels['act'];
  method: StructuredOutputMethod | undefined;
  label: string;
  metadata: PromptEvalModelMetadata;
  pricing: PromptEvalPricing | null;
} {
  const stored = loadConfig();
  const env = loadEnv();
  const apiKey = process.env.LLM_API_KEY || env.LLM_API_KEY || stored.llm_api_key;
  const baseUrl = process.env.LLM_BASE_URL
    || env.LLM_BASE_URL
    || stored.llm_base_url
    || 'https://dashscope.aliyuncs.com/compatible-mode/v1';
  const modelName = process.env.LLM_MODEL
    || env.LLM_MODEL
    || stored.llm_model
    || 'qwen3.5-plus';
  const timeout = Number(process.env.DECISION_EVAL_TIMEOUT_MS ?? 120_000);
  const temperature = readFiniteNumber(
    'PROMPT_EVAL_TEMPERATURE',
    process.env.PROMPT_EVAL_TEMPERATURE,
    0,
  );
  const reasoningEffort = process.env.PROMPT_EVAL_REASONING_EFFORT ?? 'provider-default';
  if (!apiKey) throw new Error('Missing LLM_API_KEY for real-model eval mode.');
  if (!Number.isFinite(timeout) || timeout <= 0) {
    throw new Error(`Invalid DECISION_EVAL_TIMEOUT_MS: ${process.env.DECISION_EVAL_TIMEOUT_MS ?? ''}`);
  }
  return {
    model: new ChatOpenAI({
      model: modelName,
      temperature,
      timeout,
      maxRetries: 0,
      apiKey,
      configuration: { baseURL: baseUrl, defaultHeaders: { Authorization: `Bearer ${apiKey}` } },
      ...(reasoningEffort === 'provider-default'
        ? {}
        : { modelKwargs: { reasoning_effort: reasoningEffort } }),
    }) as unknown as AgentModels['act'],
    method: readStructuredOutputMethod(
      process.env.DECISION_EVAL_STRUCTURED_OUTPUT_METHOD
      ?? process.env.DECISION_STRUCTURED_OUTPUT_METHOD,
    ) ?? inferStructuredOutputMethod(modelName, baseUrl),
    label: `${modelName} @ ${sanitizeBaseUrl(baseUrl)}`,
    metadata: {
      provider: process.env.PROMPT_EVAL_PROVIDER ?? inferProvider(baseUrl),
      family: process.env.PROMPT_EVAL_MODEL_FAMILY ?? inferModelFamily(modelName),
      model: modelName,
      baseUrl: sanitizeBaseUrl(baseUrl),
      temperature,
      reasoningEffort,
      timeoutMs: timeout,
    },
    pricing: readPricing(),
  };
}
