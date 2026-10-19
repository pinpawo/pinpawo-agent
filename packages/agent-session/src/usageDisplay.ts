import type { AgentSession } from './domain';

/** Shared wording and unknown semantics for terminal and Console status bars. */
export function formatSessionUsageMetrics(session: Pick<AgentSession, 'sessionTokenUsage' | 'tokenUsage'>): string {
  const usage = session.sessionTokenUsage ?? session.tokenUsage;
  const denominator = usage?.cacheEligibleInputTokens;
  const cached = usage?.cachedInputTokens;
  const cache = cached !== undefined && denominator && denominator > 0
    ? `${Math.round(100 * cached / denominator)}%${denominator < usage.inputTokens ? '*' : ''}` : '–';
  const speed = usage?.outputTokensPerSecond;
  const total = usage ? `${usage.incomplete ? '≥' : ''}${Math.round(usage.totalTokens).toLocaleString('en-US')}` : '–';
  return `cache: ${cache} · out: ${speed !== undefined ? `${usage?.outputRateSource === 'stream' ? '~' : ''}${speed.toFixed(1)}` : '–'} tok/s · session: ${total}`;
}
