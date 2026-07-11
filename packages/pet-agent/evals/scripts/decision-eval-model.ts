import { ChatOpenAI } from '@langchain/openai';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import type { AgentModels } from '../../src/types/agent.ts';
import type { StructuredOutputMethod } from '../../src/utils/structuredOutput.ts';
import { inferStructuredOutputMethod } from '../../src/utils/structuredOutput.ts';

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

export function createDecisionEvalModel(): {
  model: AgentModels['act'];
  method: StructuredOutputMethod | undefined;
  label: string;
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
  if (!apiKey) throw new Error('Missing LLM_API_KEY for real-model eval mode.');
  if (!Number.isFinite(timeout) || timeout <= 0) {
    throw new Error(`Invalid DECISION_EVAL_TIMEOUT_MS: ${process.env.DECISION_EVAL_TIMEOUT_MS ?? ''}`);
  }
  return {
    model: new ChatOpenAI({
      model: modelName,
      temperature: 0,
      timeout,
      maxRetries: 0,
      apiKey,
      configuration: { baseURL: baseUrl, defaultHeaders: { Authorization: `Bearer ${apiKey}` } },
    }) as unknown as AgentModels['act'],
    method: readStructuredOutputMethod(
      process.env.DECISION_EVAL_STRUCTURED_OUTPUT_METHOD
      ?? process.env.DECISION_STRUCTURED_OUTPUT_METHOD,
    ) ?? inferStructuredOutputMethod(modelName, baseUrl),
    label: `${modelName} @ ${baseUrl}`,
  };
}
