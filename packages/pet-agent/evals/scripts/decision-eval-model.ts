import { ChatOpenAI } from '@langchain/openai';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import type { AgentModels } from '../../src/types/agent.ts';
import type { StructuredOutputMethod } from '../../src/utils/structuredOutput.ts';
import { inferStructuredOutputMethod } from '../../src/utils/structuredOutput.ts';

function loadConfig(): Record<string, string> {
  try {
    return JSON.parse(readFileSync(resolve(homedir(), '.pinpawo', 'config.json'), 'utf8'));
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
  const apiKey = process.env.LLM_API_KEY || stored.llm_api_key;
  const baseUrl = process.env.LLM_BASE_URL || stored.llm_base_url || 'https://dashscope.aliyuncs.com/compatible-mode/v1';
  const modelName = process.env.LLM_MODEL || stored.llm_model || 'qwen3.5-plus';
  if (!apiKey) throw new Error('Missing LLM_API_KEY for real-model eval mode.');
  return {
    model: new ChatOpenAI({
      model: modelName,
      temperature: 0,
      apiKey,
      configuration: { baseURL: baseUrl, defaultHeaders: { Authorization: `Bearer ${apiKey}` } },
    }) as unknown as AgentModels['act'],
    method: inferStructuredOutputMethod(modelName, baseUrl),
    label: `${modelName} @ ${baseUrl}`,
  };
}
