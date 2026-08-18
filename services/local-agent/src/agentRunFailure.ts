/**
 * Failure classification for agent runs.
 *
 * A tool-level failure leaves the agent itself healthy: the step did not work,
 * but retrying is meaningful, so pending human review stays parked and the user
 * can decide again. A system-level failure means the agent cannot execute at
 * all — the model is unreachable, out of quota, or unauthorized. Retrying such
 * a run cannot succeed until an external condition changes, so anything still
 * waiting for a human decision must be terminated rather than re-offered.
 */

export type AgentRunFailureKind = 'fatal' | 'recoverable';

export type AgentRunFailure = {
  kind: AgentRunFailureKind;
  /** Set when the provider told us when capacity returns. */
  retryAt?: string;
  message: string;
};

function readErrorText(value: unknown): string {
  if (value instanceof Error) {
    return `${value.name}\n${value.message}\n${value.stack ?? ''}`;
  }
  if (value && typeof value === 'object') {
    const record = value as { message?: unknown; error?: unknown };
    if (typeof record.message === 'string') return record.message;
    if (typeof record.error === 'string') return record.error;
  }
  return String(value ?? '');
}

function readErrorStatus(value: unknown): number | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as { status?: unknown; statusCode?: unknown; code?: unknown };
  for (const candidate of [record.status, record.statusCode, record.code]) {
    if (typeof candidate === 'number' && Number.isFinite(candidate)) {
      return candidate;
    }
  }
  return null;
}

/**
 * Providers report exhausted capacity with a reset timestamp in prose, e.g.
 * "The quota will reset at 08-20 23:43:00 UTC." Surfacing it verbatim is more
 * useful than a generic retry hint, so it is extracted when present.
 */
function readRetryAt(text: string): string | undefined {
  const match = text.match(/quota will reset at ([^.\n]+)/i)
    ?? text.match(/(?:try again|retry) (?:at|after) ([^.\n]+)/i);
  return match?.[1]?.trim();
}

const FATAL_STATUS_CODES = new Set([401, 402, 403, 429]);

const FATAL_PATTERNS = [
  'insufficientquotaerror',
  'quota has been exhausted',
  'model_rate_limit',
  'rate limit',
  'insufficient_quota',
  'exceeded your current quota',
  'invalid api key',
  'incorrect api key',
  'authentication_error',
  'permission_denied',
];

/**
 * Classifies a thrown run error. Unknown failures stay `recoverable`: keeping a
 * review parked is the safe default, since wrongly terminating a resolvable
 * review loses the user's pending decision.
 */
export function classifyAgentRunFailure(value: unknown): AgentRunFailure {
  const text = readErrorText(value);
  const message = value instanceof Error ? value.message : text;
  const status = readErrorStatus(value);
  const haystack = text.toLowerCase();

  const fatal = (status !== null && FATAL_STATUS_CODES.has(status))
    || FATAL_PATTERNS.some((pattern) => haystack.includes(pattern));

  if (!fatal) {
    return { kind: 'recoverable', message };
  }
  const retryAt = readRetryAt(text);
  return {
    kind: 'fatal',
    ...(retryAt ? { retryAt } : {}),
    message,
  };
}

export function isFatalAgentRunError(value: unknown): boolean {
  return classifyAgentRunFailure(value).kind === 'fatal';
}

/** User-facing explanation for a terminated run, in the TUI's language. */
export function describeFatalAgentRunFailure(failure: AgentRunFailure): string {
  const reset = failure.retryAt
    ? `模型额度将于 ${failure.retryAt} 恢复。`
    : '模型当前不可用。';
  return `${failure.message}\n\n${reset}已终止本次运行并关闭待确认的操作，恢复后请重新发起对话。`;
}
