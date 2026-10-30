import type { AgentModels } from '@pinpawo/pet-agent';
import { AnthropicCompatibleChatModel } from './anthropicCompatibleChatModel';
import type { AgentLlmConfig } from '../config/agentConfig';
import {
  requiresLlmStreaming,
  resolveLlmGenerationReserveTokens,
} from '../config/llmModelPresets';
import { createReasoningPassbackChatOpenAI } from './reasoningPassback';

export { resolveLlmGenerationReserveTokens } from '../config/llmModelPresets';

export function buildHostModels(
  llmConfig: AgentLlmConfig,
  /** Eval-only generation override; runtime callers retain provider defaults. */
  generationOptions: { temperature?: number } = {},
): AgentModels {
  const buildModel = (
    role: 'act' | 'decision' | 'answer' | 'observe' | 'subagent',
  ) => {
    const model = role === 'observe' && llmConfig.observeModel
      ? llmConfig.observeModel
      : llmConfig.model;

    if (llmConfig.protocol && !['openai-compatible', 'anthropic-compatible'].includes(llmConfig.protocol)) {
      throw new Error(`Unsupported model protocol: ${llmConfig.protocol}`);
    }
    if (llmConfig.protocol === 'anthropic-compatible') {
      if (llmConfig.structuredOutputMethod && llmConfig.structuredOutputMethod !== 'functionCalling') {
        throw new Error('anthropic-compatible currently supports structuredOutputMethod functionCalling only');
      }
      return new AnthropicCompatibleChatModel({
        model,
        // The pinned SDK defaults thinking to disabled. Omit it so the
        // endpoint can apply its own default.
        invocationKwargs: { thinking: undefined },
        ...generationOptions,
        apiKey: llmConfig.apiKey,
        clientOptions: { baseURL: llmConfig.baseUrl, timeout: llmConfig.timeoutMs ?? 45000 },
        maxRetries: llmConfig.maxRetries ?? 2,
        ...(llmConfig.maxOutputTokens ? { maxTokens: llmConfig.maxOutputTokens } : {}),
      });
    }
    return createReasoningPassbackChatOpenAI({
      model,
      ...generationOptions,
      // Thinking and reasoning effort use provider defaults.
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
