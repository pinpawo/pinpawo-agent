import type { AgentLlmConfig } from './agentConfig';
import { getConfig } from './config';
import { resolveModelProfile } from './modelProfiles';
import { loadStoredConfig } from './storage';

export function buildLocalLlmConfig(overrides: Partial<AgentLlmConfig> = {}): AgentLlmConfig {
  const config = getConfig();
  const stored = loadStoredConfig();
  const profile = resolveModelProfile(
    config.modelProfileRegistry,
    config.modelProfileId,
  );
  return {
    apiKey: profile.apiKey,
    baseUrl: profile.baseUrl,
    model: profile.model,
    modelProfileId: profile.id,
    modelProfileFingerprint: config.modelProfileFingerprint,
    inputModalities: profile.inputModalities,
    ...(profile.structuredOutputMethod
      ? { structuredOutputMethod: profile.structuredOutputMethod }
      : {}),
    ...(profile.maxOutputTokens ? { maxOutputTokens: profile.maxOutputTokens } : {}),
    observeModel: profile.model,
    contextWindowTokens: profile.contextWindowTokens,
    timeoutMs: 120000,
    maxRetries: 2,
    subagentThinking: stored.subagent_thinking ?? false,
    structuredOutputAutoRepair: config.structuredOutputAutoRepair,
    structuredOutputRepairMaxRetries: config.structuredOutputRepairMaxRetries,
    globalReviewPolicyMode: config.globalReviewPolicyMode,
    ...overrides,
  };
}
