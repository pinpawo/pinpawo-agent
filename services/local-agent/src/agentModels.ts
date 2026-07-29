import type { AgentModels } from '@pinpawo/pet-agent';
import type { AgentLlmConfig } from './agentConfig';
import { buildLlmModelKwargs, requiresLlmStreaming } from './llmModelPresets';
import {
  LocalImageChatOpenAI,
  type LocalImageModelInputOptions,
} from './localImageModelInput';

export function buildLocalAgentModels(
  llmConfig: AgentLlmConfig,
  options: Partial<LocalImageModelInputOptions> = {},
): AgentModels {
  const subagentThinking = llmConfig.subagentThinking ?? false;

  const buildModel = (role: 'act' | 'observe' | 'subagent') => {
    const model = role === 'observe' && llmConfig.observeModel
      ? llmConfig.observeModel
      : llmConfig.model;

    const thinking = role === 'subagent' ? subagentThinking : false;
    const modelKwargs = buildLlmModelKwargs(model, thinking);

    return new LocalImageChatOpenAI({
      model,
      ...(typeof llmConfig.temperature === 'number'
        ? { temperature: llmConfig.temperature }
        : {}),
      timeout: llmConfig.timeoutMs ?? 45000,
      maxRetries: llmConfig.maxRetries ?? 2,
      apiKey: llmConfig.apiKey,
      streaming: requiresLlmStreaming(model),
      streamUsage: true,
      modelKwargs,
      configuration: {
        baseURL: llmConfig.baseUrl,
        defaultHeaders: { Authorization: `Bearer ${llmConfig.apiKey}` },
      },
    }, {
      supportedInputModalities: llmConfig.inputModalities ?? ['text'],
      ...(options.imageStore ? { imageStore: options.imageStore } : {}),
      ...(options.admitInputModalities
        ? { admitInputModalities: options.admitInputModalities }
        : {}),
    });
  };

  return {
    act: buildModel('act'),
    observe: buildModel('observe'),
    subagent: buildModel('subagent'),
  };
}
