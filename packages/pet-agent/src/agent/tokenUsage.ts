import {
  isTokenUsageSnapshot,
  parseTokenUsageSnapshot,
  type TokenUsageSnapshot,
} from '@pinpawo/agent-contracts';

export {
  isTokenUsageSnapshot,
  parseTokenUsageSnapshot,
};
export type {
  TokenUsageScope,
  TokenUsageSnapshot,
  TokenUsageSource,
} from '@pinpawo/agent-contracts';

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

function readRecord(record: Record<string, unknown>, key: string): Record<string, unknown> | null {
  const value = record[key];
  return isRecord(value) ? value : null;
}

function positiveOrZero(value: number) {
  return Math.max(0, Math.round(value));
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

function readUsageFromMessage(message: unknown): ProviderTokenUsage | null {
  if (!isRecord(message)) {
    return null;
  }

  const responseMetadata = readRecord(message, 'response_metadata')
    ?? readRecord(message, 'responseMetadata');

  // `usage_metadata` is LangChain's normalized location. Some provider
  // adapters, however, expose usage only in response metadata (notably as
  // `tokenUsage` or `usage`). Accept those provider-reported values too: the
  // compaction watermark must not silently become undecidable just because an
  // adapter chose the older response-metadata shape.
  return normalizeProviderUsage(readRecord(message, 'usage_metadata'))
    ?? normalizeProviderUsage(readRecord(message, 'usageMetadata'))
    ?? normalizeProviderUsage(responseMetadata && readRecord(responseMetadata, 'usage_metadata'))
    ?? normalizeProviderUsage(responseMetadata && readRecord(responseMetadata, 'usageMetadata'))
    ?? normalizeProviderUsage(responseMetadata && readRecord(responseMetadata, 'tokenUsage'))
    ?? normalizeProviderUsage(responseMetadata && readRecord(responseMetadata, 'usage'))
    ?? normalizeProviderUsage(responseMetadata);
}

export function readMessageTokenUsage(message: unknown): ProviderTokenUsage | null {
  return readUsageFromMessage(message);
}

export function readLatestProviderInputTokens(messages: Iterable<unknown>): number | null {
  const items = Array.isArray(messages) ? messages : [...messages];
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const usage = readMessageTokenUsage(items[index]);
    if (usage) {
      return usage.inputTokens;
    }
  }
  return null;
}

export const PROVIDER_INPUT_WATERMARK_RATIO = 0.75;

export type ProviderInputWatermark = {
  latestInputTokens: number;
  watermarkTokens: number;
};

/**
 * Shared decision helper for token-triggered maintenance guards (orchestrator
 * context compaction, subagent context rewrite). Returns the crossed watermark
 * evidence, or null when the watermark is not reached or not decidable (no
 * provider usage, no context window).
 */
export function checkProviderInputWatermark(
  latestInputTokens: number | null,
  contextWindowTokens: number | undefined,
  generationReserveTokens = 0,
): ProviderInputWatermark | null {
  if (
    latestInputTokens === null
    || !Number.isFinite(latestInputTokens)
    || !contextWindowTokens
    || !Number.isFinite(contextWindowTokens)
    || contextWindowTokens <= 0
  ) {
    return null;
  }
  const normalizedReserve = Number.isFinite(generationReserveTokens)
    ? Math.max(0, Math.floor(generationReserveTokens))
    : 0;
  const usableInputTokens = Math.max(1, contextWindowTokens - normalizedReserve);
  const watermarkTokens = Math.max(1, Math.floor(
    usableInputTokens * PROVIDER_INPUT_WATERMARK_RATIO,
  ));
  return latestInputTokens >= watermarkTokens
    ? { latestInputTokens, watermarkTokens }
    : null;
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

export function readMessagesTokenUsage(messages: Iterable<unknown>): ProviderTokenUsage | null {
  let aggregate: ProviderTokenUsage | null = null;
  for (const message of messages) {
    const usage = readMessageTokenUsage(message);
    if (!usage) {
      continue;
    }
    aggregate = addProviderUsage(aggregate, usage);
  }
  return aggregate;
}

export function createTokenUsageSnapshot(
  usage: ProviderTokenUsage | null,
  contextWindow?: number,
  latestInputTokens?: number | null,
): TokenUsageSnapshot | null {
  if (!usage) {
    return null;
  }
  return {
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    totalTokens: usage.totalTokens,
    ...(latestInputTokens !== undefined && latestInputTokens !== null
      ? { latestInputTokens: positiveOrZero(latestInputTokens) }
      : {}),
    ...(contextWindow !== undefined ? { contextWindow } : {}),
    updatedAt: new Date().toISOString(),
    source: 'provider',
    scope: 'run',
  };
}
