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
      temperature: role === 'observe' ? 0.3 : (llmConfig.temperature ?? 0.7),
      timeout: llmConfig.timeoutMs ?? 45000,
      maxRetries: llmConfig.maxRetries ?? 2,
      apiKey: llmConfig.apiKey,
      streaming: requiresLlmStreaming(model),
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
