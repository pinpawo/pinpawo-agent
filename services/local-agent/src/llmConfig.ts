import type { AgentLlmConfig } from './agentConfig';
import { config } from './config';
import { loadStoredConfig } from './storage';

export function buildLocalLlmConfig(overrides: Partial<AgentLlmConfig> = {}): AgentLlmConfig {
  const stored = loadStoredConfig();
  return {
    apiKey: config.llmApiKey,
    baseUrl: config.llmBaseUrl,
    model: config.llmModel,
    observeModel: config.llmModel,
    contextWindowTokens: config.llmContextWindowTokens,
    temperature: 0.7,
    timeoutMs: 120000,
    maxRetries: 2,
    subagentThinking: stored.subagent_thinking ?? false,
    structuredOutputAutoRepair: config.structuredOutputAutoRepair,
    structuredOutputRepairMaxRetries: config.structuredOutputRepairMaxRetries,
    ...overrides,
  };
}
