export function calculateReconnectDelay(
  attempt: number,
  initialDelayMs: number = 1_000,
  maxDelayMs: number = 30_000,
  random: () => number = Math.random,
) {
  const exponentialDelay = Math.min(maxDelayMs, initialDelayMs * 2 ** Math.max(0, attempt));
  return Math.max(1, Math.round(exponentialDelay * (0.5 + Math.min(1, Math.max(0, random())) / 2)));
}
