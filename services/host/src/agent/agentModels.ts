import type { AgentModels } from '@pinpawo/pet-agent';
import type { ChatOpenAIFields } from '@langchain/openai';
import { AnthropicCompatibleChatModel } from './anthropicCompatibleChatModel';
import type { AgentLlmConfig } from '../config/agentConfig';
import { inferLlmModelPreset, requiresLlmStreaming } from '../config/llmModelPresets';
import { createReasoningPassbackChatOpenAI, ReasoningPassbackCompletions } from './reasoningPassback';

export { resolveLlmGenerationReserveTokens } from '../config/llmModelPresets';

export type HostModelGenerationOptions = {
  /** Only the narrow Studio Head decision, not ordinary Agent roles. */
  purpose?: 'pet-head';
  /** Explicit experimental override; when omitted the provider chooses. */
  temperature?: number;
  /** Ask compatible OpenAI endpoints for deterministic output. */
  preferDeterministic?: boolean;
  /** Override default streaming when the caller requires a particular wire mode. */
  streaming?: boolean;
  /** Preserve Channel's legacy Chat Completions, max_tokens and system-role wire contract. */
  forceChatCompletions?: boolean;
};

function endpointIdentity(baseUrl: string | undefined): string | undefined {
  if (!baseUrl) return undefined;
  try {
    const url = new URL(baseUrl);
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) return undefined;
    // A root endpoint may also be configured with its /v1 API prefix.
    const path = url.pathname === '/v1' || url.pathname === '/v1/' ? '/' : url.pathname;
    return url.origin + path;
  } catch { return undefined; }
}

function headThinkingKwargs(config: AgentLlmConfig, options: HostModelGenerationOptions) {
  if (options.purpose !== 'pet-head') return undefined;
  const preset = inferLlmModelPreset(config.model);
  if (!preset?.headThinking || preset.model !== config.model || preset.thinkingControl !== 'thinking_type') return undefined;
  const endpoint = endpointIdentity(config.baseUrl);
  if (!endpoint || endpoint !== endpointIdentity(preset.baseUrl)) return undefined;
  return { thinking: { type: preset.headThinking } };
}

/** Construct one model using the Host's protocol and generation settings. */
export function buildModel(
  llmConfig: AgentLlmConfig,
  generationOptions: HostModelGenerationOptions = {},
): AgentModels['act'] {
  if (llmConfig.protocol && !['openai-compatible', 'anthropic-compatible'].includes(llmConfig.protocol)) {
    throw new Error(`Unsupported model protocol: ${llmConfig.protocol}`);
  }
  const temperature = generationOptions.temperature
    ?? (generationOptions.preferDeterministic && llmConfig.protocol !== 'anthropic-compatible' ? 0 : undefined);
  const fields = {
    model: llmConfig.model,
    apiKey: llmConfig.apiKey,
    maxRetries: llmConfig.maxRetries ?? 2,
    ...(temperature === undefined ? {} : { temperature }),
    ...(llmConfig.maxOutputTokens ? { maxTokens: llmConfig.maxOutputTokens } : {}),
  };
  if (llmConfig.protocol === 'anthropic-compatible') {
    return new AnthropicCompatibleChatModel({
      ...fields,
      ...(generationOptions.streaming !== undefined ? { streaming: generationOptions.streaming } : {}),
      clientOptions: { baseURL: llmConfig.baseUrl, timeout: llmConfig.timeoutMs ?? 45000 },
    });
  }
  const modelKwargs = headThinkingKwargs(llmConfig, generationOptions);
  const openaiFields: ChatOpenAIFields = {
    ...fields,
    ...(modelKwargs ? { modelKwargs } : {}),
    timeout: llmConfig.timeoutMs ?? 45000,
    streaming: generationOptions.streaming ?? requiresLlmStreaming(llmConfig.model),
    streamUsage: true,
    configuration: {
      baseURL: llmConfig.baseUrl,
      defaultHeaders: { Authorization: `Bearer ${llmConfig.apiKey}` },
    },
  };
  return generationOptions.forceChatCompletions
    ? new ReasoningPassbackCompletions(openaiFields, { legacyMaxTokens: true, preserveSystemRole: true })
    : createReasoningPassbackChatOpenAI(openaiFields);
}

export function buildHostModels(
  llmConfig: AgentLlmConfig,
  generationOptions: HostModelGenerationOptions = {},
): AgentModels {
  const observeConfig = llmConfig.observeModel
    ? { ...llmConfig, model: llmConfig.observeModel }
    : llmConfig;
  return {
    act: buildModel(llmConfig, generationOptions),
    decision: buildModel(llmConfig, generationOptions),
    answer: buildModel(llmConfig, generationOptions),
    observe: buildModel(observeConfig, generationOptions),
    subagent: buildModel(llmConfig, generationOptions),
  };
}
