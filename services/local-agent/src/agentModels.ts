import type { AgentModels } from '@pinpawo/pet-agent';
import type { AgentLlmConfig } from './agentConfig';
import {
  buildLlmModelKwargs,
  inferLlmAdditionalThinkingReserveTokens,
  inferLlmRoleReasoningEffort,
  inferLlmToolChoiceSupport,
  requiresLlmStreaming,
} from './llmModelPresets';
import { LocalChatOpenAI } from './localChatModel';

export function buildLocalAgentModels(
  llmConfig: AgentLlmConfig,
): AgentModels {
  const subagentThinking = llmConfig.subagentThinking ?? true;

  const buildModel = (
    role: 'act' | 'decision' | 'answer' | 'observe' | 'subagent',
  ) => {
    const model = role === 'observe' && llmConfig.observeModel
      ? llmConfig.observeModel
      : llmConfig.model;

    const thinking = role === 'answer'
      || (role === 'subagent' && subagentThinking);
    const modelKwargs = buildLlmModelKwargs(
      model,
      thinking,
      inferLlmRoleReasoningEffort(model, role),
    );

    return new LocalChatOpenAI({
      model,
      ...(typeof llmConfig.temperature === 'number'
        ? { temperature: llmConfig.temperature }
        : {}),
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
    }, {
      toolChoiceSupport: inferLlmToolChoiceSupport(model),
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

export function resolveLlmGenerationReserveTokens(
  llmConfig: Pick<AgentLlmConfig, 'model' | 'maxOutputTokens'>,
): number | undefined {
  const reserve = (llmConfig.maxOutputTokens ?? 0)
    + inferLlmAdditionalThinkingReserveTokens(llmConfig.model);
  return reserve > 0 ? reserve : undefined;
}
