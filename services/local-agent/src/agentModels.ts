import { ChatOpenAI } from '@langchain/openai';
import type { AgentModels } from '@pinpawo/pet-agent';
import type { AgentLlmConfig } from './agentConfig';
import { buildLlmModelKwargs, requiresLlmStreaming } from './llmModelPresets';

export function buildLocalAgentModels(llmConfig: AgentLlmConfig): AgentModels {
  const subagentThinking = llmConfig.subagentThinking ?? false;

  const buildModel = (role: 'act' | 'observe' | 'subagent') => {
    const model = role === 'observe' && llmConfig.observeModel
      ? llmConfig.observeModel
      : llmConfig.model;

    const thinking = role === 'subagent' ? subagentThinking : false;
    const modelKwargs = buildLlmModelKwargs(model, thinking);

    return new ChatOpenAI({
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
    });
  };

  return {
    act: buildModel('act'),
    observe: buildModel('observe'),
    subagent: buildModel('subagent'),
  };
}
