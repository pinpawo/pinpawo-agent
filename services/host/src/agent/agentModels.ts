import type { AgentModels } from '@pinpawo/pet-agent';
import type { ChatOpenAIFields } from '@langchain/openai';
import { AnthropicCompatibleChatModel } from './anthropicCompatibleChatModel';
import type { AgentLlmConfig } from '../config/agentConfig';
import {
  requiresLlmStreaming,
  resolveLlmGenerationReserveTokens,
} from '../config/llmModelPresets';
import { createReasoningPassbackChatOpenAI, ReasoningPassbackCompletions } from './reasoningPassback';

export { resolveLlmGenerationReserveTokens } from '../config/llmModelPresets';

export type HostModelGenerationOptions = {
  /** Explicit experimental override; when omitted the provider chooses. */
  temperature?: number;
  /** Ask compatible OpenAI endpoints for deterministic output. */
  preferDeterministic?: boolean;
  /** Override default streaming when the caller requires a particular wire mode. */
  streaming?: boolean;
  /** Keep OpenAI-compatible calls on Chat Completions for legacy endpoints. */
  forceChatCompletions?: boolean;
};

/** Construct one model using the Host's protocol and generation settings. */
export function buildHostModel(
  llmConfig: AgentLlmConfig,
  generationOptions: HostModelGenerationOptions = {},
): AgentModels['act'] {
  const model = llmConfig.model;
  if (llmConfig.protocol && !['openai-compatible', 'anthropic-compatible'].includes(llmConfig.protocol)) {
    throw new Error(`Unsupported model protocol: ${llmConfig.protocol}`);
  }
  const temperature = generationOptions.temperature
    ?? (generationOptions.preferDeterministic && llmConfig.protocol !== 'anthropic-compatible' ? 0 : undefined);
  const sampling = temperature === undefined ? {} : { temperature };
  if (llmConfig.protocol === 'anthropic-compatible') {
    if (llmConfig.structuredOutputMethod && llmConfig.structuredOutputMethod !== 'functionCalling') {
      throw new Error('anthropic-compatible currently supports structuredOutputMethod functionCalling only');
    }
    return new AnthropicCompatibleChatModel({
      model,
      // The pinned SDK defaults thinking to disabled. Omit it so the
      // endpoint can apply its own default.
      invocationKwargs: { thinking: undefined },
      ...sampling,
      ...(generationOptions.streaming !== undefined ? { streaming: generationOptions.streaming } : {}),
      apiKey: llmConfig.apiKey,
      clientOptions: { baseURL: llmConfig.baseUrl, timeout: llmConfig.timeoutMs ?? 45000 },
      maxRetries: llmConfig.maxRetries ?? 2,
      ...(llmConfig.maxOutputTokens ? { maxTokens: llmConfig.maxOutputTokens } : {}),
    });
  }
  const fields: ChatOpenAIFields = {
    model,
    ...sampling,
    // Thinking and reasoning effort use provider defaults.
    timeout: llmConfig.timeoutMs ?? 45000,
    maxRetries: llmConfig.maxRetries ?? 2,
    apiKey: llmConfig.apiKey,
    ...(llmConfig.maxOutputTokens
      ? { maxTokens: llmConfig.maxOutputTokens }
      : {}),
    streaming: generationOptions.streaming ?? requiresLlmStreaming(model),
    streamUsage: true,
    configuration: {
      baseURL: llmConfig.baseUrl,
      defaultHeaders: { Authorization: `Bearer ${llmConfig.apiKey}` },
    },
  };
  return generationOptions.forceChatCompletions
    ? new ReasoningPassbackCompletions(fields, { legacyMaxTokens: true, preserveSystemRole: true })
    : createReasoningPassbackChatOpenAI(fields);
}

export function buildHostModels(
  llmConfig: AgentLlmConfig,
  generationOptions: HostModelGenerationOptions = {},
): AgentModels {
  const observeConfig = llmConfig.observeModel
    ? { ...llmConfig, model: llmConfig.observeModel }
    : llmConfig;
  return {
    act: buildHostModel(llmConfig, generationOptions),
    decision: buildHostModel(llmConfig, generationOptions),
    answer: buildHostModel(llmConfig, generationOptions),
    observe: buildHostModel(observeConfig, generationOptions),
    subagent: buildHostModel(llmConfig, generationOptions),
  };
}
