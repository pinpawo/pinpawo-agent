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

function readUsageFromMessage(message: unknown): ProviderTokenUsage | null {
  if (!isRecord(message)) {
    return null;
  }

  return normalizeProviderUsage(readRecord(message, 'usage_metadata'))
    ?? normalizeProviderUsage(readRecord(message, 'usageMetadata'));
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

/**
 * The default ratio of `contextWindowTokens` at which a watermark guard
 * should trigger compaction or context rewrite. Both orchestrator compaction
 * and subagent context rewrite use this same threshold.
 */
export const DEFAULT_PROVIDER_INPUT_WATERMARK_RATIO = 0.75;

/**
 * Read the latest provider input-token count from `messages` and compare it
 * against the watermark derived from `contextWindowTokens`.
 *
 * Returns `null` when the watermark is not reached (pass), or the watermark
 * details when it is (block). Both orchestrator compaction and subagent
 * context-rewrite guards share this logic.
 */
export function readProviderInputWatermark(params: {
  messages: Iterable<unknown>;
  contextWindowTokens: number | null | undefined;
  ratio?: number;
}): { latestInputTokens: number; watermarkTokens: number } | null {
  const { messages, contextWindowTokens, ratio } = params;
  if (!contextWindowTokens || !Number.isFinite(contextWindowTokens) || contextWindowTokens <= 0) {
    return null;
  }
  const latestInputTokens = readLatestProviderInputTokens(messages);
  if (latestInputTokens === null) {
    return null;
  }
  const watermarkRatio = ratio ?? DEFAULT_PROVIDER_INPUT_WATERMARK_RATIO;
  const watermarkTokens = Math.max(1, Math.floor(contextWindowTokens * watermarkRatio));
  if (latestInputTokens < watermarkTokens) {
    return null;
  }
  return { latestInputTokens, watermarkTokens };
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
): TokenUsageSnapshot | null {
  if (!usage) {
    return null;
  }
  return {
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    totalTokens: usage.totalTokens,
    ...(contextWindow !== undefined ? { contextWindow } : {}),
    updatedAt: new Date().toISOString(),
    source: 'provider',
    scope: 'run',
  };
}
