import type { CallbackHandlerMethods } from '@langchain/core/callbacks/base';
import type { BaseMessage } from '@langchain/core/messages';
import type { LLMResult } from '@langchain/core/outputs';

export type TokenUsageSource = 'provider';
export type TokenUsageScope = 'run';

export type TokenUsageSnapshot = {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  contextWindow?: number;
  updatedAt?: string;
  source?: TokenUsageSource;
  scope?: TokenUsageScope;
};

export type ProviderTokenUsage = {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function readNumber(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function readString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === 'string' ? value : undefined;
}

function readRecord(record: Record<string, unknown>, key: string): Record<string, unknown> | null {
  const value = record[key];
  return isRecord(value) ? value : null;
}

function positiveOrZero(value: number) {
  return Math.max(0, Math.round(value));
}

export function parseTokenUsageSnapshot(value: unknown): TokenUsageSnapshot | null {
  if (!isRecord(value)) {
    return null;
  }

  const inputTokens = readNumber(value, 'inputTokens');
  const outputTokens = readNumber(value, 'outputTokens');
  const totalTokens = readNumber(value, 'totalTokens');
  if (inputTokens === undefined || outputTokens === undefined || totalTokens === undefined) {
    return null;
  }

  const contextWindow = readNumber(value, 'contextWindow');
  const updatedAt = readString(value, 'updatedAt');
  const rawSource = readString(value, 'source');
  const rawScope = readString(value, 'scope');
  return {
    inputTokens,
    outputTokens,
    totalTokens,
    ...(contextWindow !== undefined ? { contextWindow } : {}),
    ...(updatedAt !== undefined ? { updatedAt } : {}),
    ...(rawSource === 'provider' ? { source: rawSource } : {}),
    ...(rawScope === 'run' ? { scope: rawScope } : {}),
  };
}

export function isTokenUsageSnapshot(value: unknown): value is TokenUsageSnapshot {
  return parseTokenUsageSnapshot(value) !== null;
}

function normalizeProviderUsage(value: unknown): ProviderTokenUsage | null {
  if (!isRecord(value)) {
    return null;
  }

  const topLevelCacheInput = (
    readNumber(value, 'cache_creation_input_tokens') ?? 0
  ) + (
    readNumber(value, 'cache_read_input_tokens') ?? 0
  );
  const inputTokens = readNumber(value, 'input_tokens')
    ?? readNumber(value, 'inputTokens')
    ?? readNumber(value, 'prompt_tokens')
    ?? readNumber(value, 'promptTokens');
  const outputTokens = readNumber(value, 'output_tokens')
    ?? readNumber(value, 'outputTokens')
    ?? readNumber(value, 'completion_tokens')
    ?? readNumber(value, 'completionTokens');
  const totalTokens = readNumber(value, 'total_tokens')
    ?? readNumber(value, 'totalTokens');

  if (inputTokens === undefined && outputTokens === undefined && totalTokens === undefined) {
    return null;
  }

  const normalizedInputTokens = positiveOrZero((inputTokens ?? 0) + topLevelCacheInput);
  const normalizedOutputTokens = positiveOrZero(outputTokens ?? 0);
  return {
    inputTokens: normalizedInputTokens,
    outputTokens: normalizedOutputTokens,
    totalTokens: positiveOrZero(totalTokens ?? normalizedInputTokens + normalizedOutputTokens),
  };
}

function readUsageFromRecord(record: Record<string, unknown>): ProviderTokenUsage | null {
  return normalizeProviderUsage(record)
    ?? normalizeProviderUsage(readRecord(record, 'usage_metadata'))
    ?? normalizeProviderUsage(readRecord(record, 'usageMetadata'))
    ?? normalizeProviderUsage(readRecord(record, 'usage'))
    ?? normalizeProviderUsage(readRecord(record, 'tokenUsage'));
}

function readUsageFromMessage(message: unknown): ProviderTokenUsage | null {
  if (!isRecord(message)) {
    return null;
  }

  const directUsage = readUsageFromRecord(message);
  if (directUsage) {
    return directUsage;
  }

  const responseMetadata = readRecord(message, 'response_metadata')
    ?? readRecord(message, 'responseMetadata');
  return responseMetadata ? readUsageFromRecord(responseMetadata) : null;
}

function readUsageFromGeneration(generation: unknown): ProviderTokenUsage | null {
  if (!isRecord(generation)) {
    return null;
  }

  const messageUsage = readUsageFromMessage(generation.message);
  if (messageUsage) {
    return messageUsage;
  }

  const generationInfo = readRecord(generation, 'generationInfo')
    ?? readRecord(generation, 'generation_info');
  return generationInfo ? readUsageFromRecord(generationInfo) : null;
}

export function readLlmResultTokenUsage(output: LLMResult): ProviderTokenUsage | null {
  const llmOutputUsage = readUsageFromRecord(output.llmOutput ?? {});
  if (llmOutputUsage) {
    return llmOutputUsage;
  }

  const generations = Array.isArray(output.generations) ? output.generations : [];
  let aggregate: ProviderTokenUsage | null = null;
  for (const group of generations) {
    if (!Array.isArray(group)) {
      continue;
    }
    for (const generation of group) {
      const usage = readUsageFromGeneration(generation);
      if (!usage) {
        continue;
      }
      aggregate = addProviderUsage(aggregate, usage);
    }
  }
  return aggregate;
}

function addProviderUsage(
  current: ProviderTokenUsage | null,
  next: ProviderTokenUsage,
): ProviderTokenUsage {
  return {
    inputTokens: (current?.inputTokens ?? 0) + next.inputTokens,
    outputTokens: (current?.outputTokens ?? 0) + next.outputTokens,
    totalTokens: (current?.totalTokens ?? 0) + next.totalTokens,
  };
}

export class LlmTokenUsageAccumulator {
  private usage: ProviderTokenUsage | null = null;
  private readonly completedRunIds = new Set<string>();

  readonly callbackHandler: CallbackHandlerMethods = {
    handleLLMEnd: (output, runId) => {
      if (this.completedRunIds.has(runId)) {
        return;
      }
      const usage = readLlmResultTokenUsage(output);
      if (!usage) {
        return;
      }
      this.completedRunIds.add(runId);
      this.usage = addProviderUsage(this.usage, usage);
    },
  };

  addMessageUsage(message: BaseMessage) {
    const usage = readUsageFromMessage(message);
    if (usage) {
      this.usage = addProviderUsage(this.usage, usage);
    }
  }

  readUsage(contextWindow?: number): TokenUsageSnapshot | null {
    if (!this.usage) {
      return null;
    }
    return {
      inputTokens: this.usage.inputTokens,
      outputTokens: this.usage.outputTokens,
      totalTokens: this.usage.totalTokens,
      ...(contextWindow !== undefined ? { contextWindow } : {}),
      updatedAt: new Date().toISOString(),
      source: 'provider',
      scope: 'run',
    };
  }
}
