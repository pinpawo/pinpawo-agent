export function calculateReconnectDelay(
  attempt,
  initialDelayMs = 1_000,
  maxDelayMs = 30_000,
  random = Math.random,
) {
  const exponentialDelay = Math.min(maxDelayMs, initialDelayMs * 2 ** Math.max(0, attempt));
  return Math.max(1, Math.round(exponentialDelay * (0.5 + Math.min(1, Math.max(0, random())) / 2)));
}
