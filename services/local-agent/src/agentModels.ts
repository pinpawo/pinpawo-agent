import type { AgentModels } from '@pinpawo/pet-agent';
import type { AgentLlmConfig } from './agentConfig';
import { ChatOpenAI } from '@langchain/openai';
import {
  buildLlmModelKwargs,
  inferLlmRoleReasoningEffort,
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

    const thinking = role === 'answer' || role === 'subagent';
    const modelKwargs = buildLlmModelKwargs(
      model,
      thinking,
      inferLlmRoleReasoningEffort(model, role),
    );

    return new ChatOpenAI({
      model,
      // Leave temperature to the provider; thinking follows the role policy.
      timeout: llmConfig.timeoutMs ?? 45000,
      maxRetries: llmConfig.maxRetries ?? 2,
      apiKey: llmConfig.apiKey,
      ...(llmConfig.maxOutputTokens
        ? { maxTokens: llmConfig.maxOutputTokens }
        : {}),
      streaming: requiresLlmStreaming(model),
      streamUsage: true,
      modelKwargs,
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
