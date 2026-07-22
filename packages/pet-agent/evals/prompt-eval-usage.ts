import { BaseCallbackHandler } from '@langchain/core/callbacks/base';
import type { LLMResult } from '@langchain/core/outputs';
import {
  readMessageTokenUsage,
  type ProviderTokenUsage,
} from '../src/agent/tokenUsage.ts';

export type PromptEvalPricing = {
  inputUsdPerMillionTokens: number;
  outputUsdPerMillionTokens: number;
};

function addUsage(
  current: ProviderTokenUsage | null,
  next: ProviderTokenUsage,
): ProviderTokenUsage {
  return {
    inputTokens: (current?.inputTokens ?? 0) + next.inputTokens,
    outputTokens: (current?.outputTokens ?? 0) + next.outputTokens,
    totalTokens: (current?.totalTokens ?? 0) + next.totalTokens,
  };
}

function usageFromProviderRecord(value: unknown): ProviderTokenUsage | null {
  return readMessageTokenUsage({ usage_metadata: value });
}

export function readLlmResultTokenUsage(output: LLMResult): ProviderTokenUsage | null {
  let usage: ProviderTokenUsage | null = null;
  for (const generations of output.generations) {
    for (const generation of generations) {
      if (!('message' in generation)) continue;
      const messageUsage = readMessageTokenUsage(generation.message);
      if (messageUsage) usage = addUsage(usage, messageUsage);
    }
  }
  if (usage) return usage;

  const llmOutput = output.llmOutput;
  if (!llmOutput) return null;
  return usageFromProviderRecord(llmOutput.tokenUsage)
    ?? usageFromProviderRecord(llmOutput.usage)
    ?? usageFromProviderRecord(llmOutput);
}

export function createPromptEvalUsageCollector() {
  let usage: ProviderTokenUsage | null = null;
  const callback = BaseCallbackHandler.fromMethods({
    handleLLMEnd(output) {
      const next = readLlmResultTokenUsage(output);
      if (next) usage = addUsage(usage, next);
    },
  });
  return {
    callback,
    read: () => usage,
  };
}

export function estimatePromptEvalCost(
  usage: ProviderTokenUsage | null,
  pricing: PromptEvalPricing | null,
): number | null {
  if (!usage || !pricing) return null;
  return Number(((
    (usage.inputTokens * pricing.inputUsdPerMillionTokens)
    + (usage.outputTokens * pricing.outputUsdPerMillionTokens)
  ) / 1_000_000).toFixed(8));
}
