import type { AgentModelRequestPolicy } from '@pinpawo/pet-agent';
import type { AgentLlmConfig } from './agentConfig';
import {
  prepareLocalImageModelMessages,
  type LocalImageModelInputOptions,
} from './localImageModelInput';
import { inferLlmToolChoiceSupport } from './llmModelPresets';

export function normalizeLocalToolChoice(
  support: ReturnType<typeof inferLlmToolChoiceSupport>,
  toolChoice: unknown,
): unknown {
  return support === 'auto_only'
    && toolChoice !== undefined
    && toolChoice !== 'auto'
    && toolChoice !== 'none'
    ? 'auto'
    : toolChoice;
}

export function createLocalModelRequestPolicy(
  llmConfig: AgentLlmConfig,
  options: Partial<LocalImageModelInputOptions> = {},
): AgentModelRequestPolicy {
  const imageOptions: LocalImageModelInputOptions = {
    supportedInputModalities: llmConfig.inputModalities ?? ['text'],
    ...(options.imageStore ? { imageStore: options.imageStore } : {}),
    ...(options.admitInputModalities
      ? { admitInputModalities: options.admitInputModalities }
      : {}),
  };
  const toolChoiceSupport = inferLlmToolChoiceSupport(llmConfig.model);

  return {
    prepareMessages: (messages) => prepareLocalImageModelMessages(
      messages,
      imageOptions,
    ),
    normalizeToolChoice: (toolChoice) => normalizeLocalToolChoice(
      toolChoiceSupport,
      toolChoice,
    ),
  };
}
