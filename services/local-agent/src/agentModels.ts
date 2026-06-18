import { ChatOpenAI } from '@langchain/openai';
import type { AgentModels } from '@pinpawo/pet-agent';
import type { AgentLlmConfig } from './agentConfig';

function buildModelKwargs(model: string, thinking: boolean) {
  const normalizedModel = model.toLowerCase();
  if (
    normalizedModel.includes('qwen')
    || normalizedModel.includes('glm')
    || normalizedModel.includes('minimax')
  ) {
    return { extra_body: { enable_thinking: thinking } };
  }
  if (normalizedModel.includes('deepseek')) {
    return { thinking: { type: thinking ? 'enabled' : 'disabled' } };
  }
  return undefined;
}

function requiresStreaming(model: string): boolean {
  const normalizedModel = model.toLowerCase();
  return normalizedModel.includes('glm-4.5');
}

export function buildLocalAgentModels(llmConfig: AgentLlmConfig): AgentModels {
  const subagentThinking = llmConfig.subagentThinking ?? false;

  const buildModel = (role: 'act' | 'observe' | 'subagent') => {
    const model = role === 'observe' && llmConfig.observeModel
      ? llmConfig.observeModel
      : llmConfig.model;

    const thinking = role === 'subagent' ? subagentThinking : false;
    const modelKwargs = buildModelKwargs(model, thinking);

    return new ChatOpenAI({
      model,
      temperature: role === 'observe' ? 0.3 : (llmConfig.temperature ?? 0.7),
      timeout: llmConfig.timeoutMs ?? 45000,
      maxRetries: llmConfig.maxRetries ?? 2,
      apiKey: llmConfig.apiKey,
      streaming: requiresStreaming(model),
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
