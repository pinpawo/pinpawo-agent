/** Provider-reported token counts only. Missing counters are unknown, not zero. */
export function readCacheUsage(usage: Record<string, any> | undefined): { cacheHitTokens?: number; cacheMissTokens?: number } {
  const hit = usage?.prompt_cache_hit_tokens ?? usage?.prompt_tokens_details?.cached_tokens ?? usage?.cache_read_input_tokens;
  const miss = usage?.prompt_cache_miss_tokens;
  return {
    ...(Number.isSafeInteger(hit) && hit >= 0 ? { cacheHitTokens: hit } : {}),
    ...(Number.isSafeInteger(miss) && miss >= 0 ? { cacheMissTokens: miss } : {}),
  };
}
