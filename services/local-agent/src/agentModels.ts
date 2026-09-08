import type { AgentModels } from '@pinpawo/pet-agent';
import type { AgentLlmConfig } from './agentConfig';
import { ChatOpenAI } from '@langchain/openai';
import {
  requiresLlmStreaming,
  resolveLlmGenerationReserveTokens,
} from './llmModelPresets';

export { resolveLlmGenerationReserveTokens } from './llmModelPresets';

export function buildLocalAgentModels(
  llmConfig: AgentLlmConfig,
): AgentModels {
  const buildModel = (
    role: 'act' | 'decision' | 'answer' | 'observe' | 'subagent',
  ) => {
    const model = role === 'observe' && llmConfig.observeModel
      ? llmConfig.observeModel
      : llmConfig.model;

    return new ChatOpenAI({
      model,
      // Leave temperature to the provider; thinking and reasoning effort also use provider defaults.
      timeout: llmConfig.timeoutMs ?? 45000,
      maxRetries: llmConfig.maxRetries ?? 2,
      apiKey: llmConfig.apiKey,
      ...(llmConfig.maxOutputTokens
        ? { maxTokens: llmConfig.maxOutputTokens }
        : {}),
      streaming: requiresLlmStreaming(model),
      streamUsage: true,
      configuration: {
        baseURL: llmConfig.baseUrl,
        defaultHeaders: { Authorization: `Bearer ${llmConfig.apiKey}` },
      },
    });
  };

  return {
    act: buildModel('act'),
    decision: buildModel('decision'),
    answer: buildModel('answer'),
    observe: buildModel('observe'),
    subagent: buildModel('subagent'),
  };
}
