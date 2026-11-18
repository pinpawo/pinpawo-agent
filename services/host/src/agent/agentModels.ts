import type { AgentModels } from '@pinpawo/pet-agent';
import type { ChatOpenAIFields } from '@langchain/openai';
import { AnthropicCompatibleChatModel } from './anthropicCompatibleChatModel';
import type { AgentLlmConfig } from '../config/agentConfig';
import { requiresLlmStreaming } from '../config/llmModelPresets';
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

function isOfficialDeepSeekHead(config: AgentLlmConfig, options: HostModelGenerationOptions): boolean {
  if (options.purpose !== 'pet-head' || (config.protocol && config.protocol !== 'openai-compatible')
    || !['deepseek-flash', 'deepseek-v4-pro'].includes(config.model)) return false;
  try {
    const url = new URL(config.baseUrl);
    return url.protocol === 'https:' && url.hostname === 'api.deepseek.com' && (!url.port || url.port === '443')
      && !url.username && !url.password && !url.search && !url.hash && ['/', '/v1', '/v1/'].includes(url.pathname);
  } catch { return false; }
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
  const openaiFields: ChatOpenAIFields = {
    ...fields,
    // Official DeepSeek Head decisions have a small bounded JSON budget. Leave
    // every Agent role, gateway and other protocol on its unchanged defaults.
    ...(isOfficialDeepSeekHead(llmConfig, generationOptions) ? { modelKwargs: { thinking: { type: 'disabled' } } } : {}),
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
