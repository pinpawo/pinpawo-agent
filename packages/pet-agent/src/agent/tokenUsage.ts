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
  cachedInputTokens?: number;
  cacheEligibleInputTokens?: number;
  incomplete?: boolean;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function readNumber(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
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

  const isRawAnthropic = readNumber(value, 'input_tokens') !== undefined
    && !readRecord(value, 'input_token_details')
    && (readNumber(value, 'cache_creation_input_tokens') !== undefined || readNumber(value, 'cache_read_input_tokens') !== undefined);
  const topLevelCacheInput = isRawAnthropic ? (
    readNumber(value, 'cache_creation_input_tokens') ?? 0
  ) + (
    readNumber(value, 'cache_read_input_tokens') ?? 0
  ) : 0;
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

  const details = readRecord(value, 'input_token_details')
    ?? readRecord(value, 'prompt_tokens_details')
    ?? readRecord(value, 'input_tokens_details');
  const reportedCachedInputTokens = readNumber(value, 'cachedInputTokens')
    ?? (details ? readNumber(details, 'cache_read') ?? readNumber(details, 'cached_tokens') : undefined)
    ?? readNumber(value, 'cache_read_input_tokens')
    ?? readNumber(value, 'prompt_cache_hit_tokens');
  const normalizedInputTokens = positiveOrZero((inputTokens ?? 0) + topLevelCacheInput);
  const cacheEligibleInputTokens = readNumber(value, 'cacheEligibleInputTokens') ?? normalizedInputTokens;
  const cachedInputTokens = inputTokens !== undefined && reportedCachedInputTokens !== undefined
    && reportedCachedInputTokens <= cacheEligibleInputTokens && cacheEligibleInputTokens <= normalizedInputTokens
    ? reportedCachedInputTokens : undefined;
  const normalizedOutputTokens = positiveOrZero(outputTokens ?? 0);
  return {
    ...(cachedInputTokens !== undefined ? {
      cachedInputTokens: Math.min(normalizedInputTokens, positiveOrZero(cachedInputTokens)),
      cacheEligibleInputTokens,
    } : {}),
    ...(inputTokens === undefined || outputTokens === undefined || value.incomplete === true ? { incomplete: true } : {}),
    inputTokens: normalizedInputTokens,
    outputTokens: normalizedOutputTokens,
    totalTokens: positiveOrZero(totalTokens ?? normalizedInputTokens + normalizedOutputTokens),
  };
}

function usageCandidates(message: unknown): Record<string, unknown>[] {
  if (!isRecord(message)) return [];
  const response = readRecord(message, 'response_metadata') ?? readRecord(message, 'responseMetadata');
  return [readRecord(message, 'usage_metadata'), readRecord(message, 'usageMetadata'),
    response && readRecord(response, 'usage_metadata'), response && readRecord(response, 'usageMetadata'),
    response && readRecord(response, 'tokenUsage'), response && readRecord(response, 'usage'), response]
    .filter((value): value is Record<string, unknown> => value !== null);
}

function knownCount(value: Record<string, unknown>, keys: string[]) {
  return keys.some(key => readNumber(value, key) !== undefined);
}
const INPUT_KEYS = ['input_tokens', 'inputTokens', 'prompt_tokens', 'promptTokens'];
const OUTPUT_KEYS = ['output_tokens', 'outputTokens', 'completion_tokens', 'completionTokens'];

function readUsageFromMessage(message: unknown): ProviderTokenUsage | null {
  const observations = usageCandidates(message).flatMap(raw => {
    const usage = normalizeProviderUsage(raw);
    return usage ? [{ raw, usage }] : [];
  });
  const first = observations[0];
  if (!first) return null;
  // Prefer normalized metadata, but a partial normalized report must not hide
  // a compatible complete provider report retained in response metadata.
  const complete = first.usage.incomplete && first.raw.incomplete !== true
    ? observations.find(next => !next.usage.incomplete
      && (!knownCount(first.raw, INPUT_KEYS) || next.usage.inputTokens === first.usage.inputTokens)
      && (!knownCount(first.raw, OUTPUT_KEYS) || next.usage.outputTokens === first.usage.outputTokens)) : undefined;
  const preferred = complete?.usage ?? first.usage;
  if (preferred.cachedInputTokens !== undefined) return preferred;
  const cache = observations.find(next => next.usage.cachedInputTokens !== undefined
    && next.usage.inputTokens === preferred.inputTokens)?.usage;
  return cache ? { ...preferred, cachedInputTokens: cache.cachedInputTokens,
    cacheEligibleInputTokens: cache.cacheEligibleInputTokens } : preferred;
}

export function readMessageTokenUsage(message: unknown): ProviderTokenUsage | null {
  return readUsageFromMessage(message);
}

export function readLatestProviderInputTokens(messages: Iterable<unknown>): number | null {
  const items = Array.isArray(messages) ? messages : [...messages];
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const candidates = usageCandidates(items[index]);
    const input = candidates.find(raw => knownCount(raw, INPUT_KEYS));
    if (input) return normalizeProviderUsage(input)?.inputTokens ?? null;
    // A newer usage report without input makes the latest context unknown;
    // never substitute zero or reuse an older call's input size.
    if (candidates.some(raw => normalizeProviderUsage(raw))) return null;
  }
  return null;
}

export const PROVIDER_INPUT_WATERMARK_RATIO = 0.75;

export type ProviderInputWatermark = {
  latestInputTokens: number;
  watermarkTokens: number;
};

/**
 * Returns the maximum observed provider input size before context compaction
 * should run. Generation and reasoning reserves are excluded before the shared
 * watermark ratio is applied.
 */
export function resolveProviderInputWatermarkTokens(
  contextWindowTokens: number | undefined,
  generationReserveTokens = 0,
): number | null {
  if (
    !contextWindowTokens
    || !Number.isFinite(contextWindowTokens)
    || contextWindowTokens <= 0
  ) {
    return null;
  }
  const normalizedReserve = Number.isFinite(generationReserveTokens)
    ? Math.max(0, Math.floor(generationReserveTokens))
    : 0;
  const usableInputTokens = Math.max(1, contextWindowTokens - normalizedReserve);
  return Math.max(1, Math.floor(
    usableInputTokens * PROVIDER_INPUT_WATERMARK_RATIO,
  ));
}

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
  ) {
    return null;
  }
  const watermarkTokens = resolveProviderInputWatermarkTokens(
    contextWindowTokens,
    generationReserveTokens,
  );
  if (watermarkTokens === null) {
    return null;
  }
  return latestInputTokens >= watermarkTokens
    ? { latestInputTokens, watermarkTokens }
    : null;
}

function addProviderUsage(
  current: ProviderTokenUsage | null,
  next: ProviderTokenUsage,
): ProviderTokenUsage {
  return {
    ...(current?.incomplete || next.incomplete ? { incomplete: true } : {}),
    inputTokens: (current?.inputTokens ?? 0) + next.inputTokens,
    outputTokens: (current?.outputTokens ?? 0) + next.outputTokens,
    totalTokens: (current?.totalTokens ?? 0) + next.totalTokens,
    ...((current?.cachedInputTokens !== undefined || next.cachedInputTokens !== undefined) ? {
      cachedInputTokens: (current?.cachedInputTokens ?? 0) + (next.cachedInputTokens ?? 0),
      cacheEligibleInputTokens: (current?.cacheEligibleInputTokens ?? 0) + (next.cacheEligibleInputTokens ?? 0),
    } : {}),
  };
}

export function readMessagesTokenUsage(messages: Iterable<unknown>): ProviderTokenUsage | null {
  let aggregate: ProviderTokenUsage | null = null;
  for (const message of messages) {
    // Delegation ToolMessages carry the child invocation usage. Do not treat it as a model's latest input size.
    const additional = isRecord(message) && readRecord(message, 'additional_kwargs');
    const metadata = additional && readRecord(additional, 'pinpawo');
    const usage = readMessageTokenUsage(message)
      ?? normalizeProviderUsage(metadata && readRecord(metadata, 'capabilityTokenUsage'));
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
    ...usage,
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
