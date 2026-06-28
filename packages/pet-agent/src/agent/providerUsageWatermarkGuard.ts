import { readLatestProviderInputTokens } from './tokenUsage';

/**
 * Deterministic context-pressure guard based on provider-reported prompt usage.
 * It never estimates tokens and never rewrites messages; callers decide what
 * action to take when `triggered` is true.
 */
export const DEFAULT_PROVIDER_USAGE_WATERMARK_RATIO = 0.75;

export type ProviderUsageWatermarkGuardInput = {
  messages?: Iterable<unknown>;
  latestInputTokens?: number | null;
  budgetTokens?: number;
  thresholdRatio?: number;
  triggerTokens?: number;
};

export type ProviderUsageWatermarkGuardVerdict = {
  kind: 'provider_usage_watermark';
  triggered: boolean;
  latestInputTokens: number | null;
  triggerTokens: number | null;
};

function normalizeNonNegativeTokens(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    return null;
  }
  return Math.round(value);
}

function normalizePositiveTokens(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return null;
  }
  return Math.max(1, Math.floor(value));
}

export function buildProviderUsageWatermarkTriggerTokens(params: {
  budgetTokens?: number;
  thresholdRatio?: number;
  triggerTokens?: number;
}): number | null {
  if (params.triggerTokens !== undefined) {
    return normalizePositiveTokens(params.triggerTokens);
  }

  const budgetTokens = normalizePositiveTokens(params.budgetTokens);
  if (budgetTokens === null) {
    return null;
  }

  const thresholdRatio = typeof params.thresholdRatio === 'number' && Number.isFinite(params.thresholdRatio)
    ? params.thresholdRatio
    : DEFAULT_PROVIDER_USAGE_WATERMARK_RATIO;
  return Math.max(1, Math.floor(budgetTokens * thresholdRatio));
}

export function evaluateProviderUsageWatermarkGuard(
  input: ProviderUsageWatermarkGuardInput,
): ProviderUsageWatermarkGuardVerdict {
  const latestInputTokens = input.latestInputTokens !== undefined
    ? normalizeNonNegativeTokens(input.latestInputTokens)
    : input.messages
      ? readLatestProviderInputTokens(input.messages)
      : null;
  const triggerTokens = buildProviderUsageWatermarkTriggerTokens({
    budgetTokens: input.budgetTokens,
    thresholdRatio: input.thresholdRatio,
    triggerTokens: input.triggerTokens,
  });

  return {
    kind: 'provider_usage_watermark',
    triggered: latestInputTokens !== null
      && triggerTokens !== null
      && latestInputTokens >= triggerTokens,
    latestInputTokens,
    triggerTokens,
  };
}
