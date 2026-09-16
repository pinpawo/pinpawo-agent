/**
 * Failure classification for agent runs.
 *
 * A tool-level failure leaves the agent itself healthy: the step did not work,
 * but retrying is meaningful, so pending human review stays parked and the user
 * can decide again. A system-level failure means the agent cannot execute at
 * all — the model is out of quota, or its credentials are rejected. Retrying
 * such a run cannot succeed until an external condition changes, so anything
 * still waiting for a human decision must be terminated rather than re-offered.
 *
 * The distinction is not inferred from status codes or message text. LangChain
 * already draws it upstream: model integrations stamp `lc_error_code` (a
 * `LangChainErrorCodes` value) onto errors raised by the model call itself, and
 * nothing else in the run carries that field. A rate-limited GitHub call or a
 * browser 403 therefore stays recoverable by construction.
 */

/**
 * Codes that mean the agent's own model is unusable. Deliberately narrow:
 *
 * - MODEL_RATE_LIMIT     — quota or rate limit exhausted (the 429 case).
 * - MODEL_AUTHENTICATION — credentials rejected (401).
 * - MODEL_NOT_FOUND      — the configured model does not exist (404).
 *
 * Other LangChain codes are intentionally absent: CONTEXT_OVERFLOW is
 * recoverable by compacting context, and INVALID_TOOL_RESULTS has its own
 * session-reset path. Both must keep a pending review resolvable.
 */
const FATAL_MODEL_ERROR_CODES = new Set([
  'MODEL_RATE_LIMIT',
  'MODEL_AUTHENTICATION',
  'MODEL_NOT_FOUND',
]);

export type AgentRunFailureKind = 'fatal' | 'recoverable';

export type AgentRunFailure = {
  kind: AgentRunFailureKind;
  /** The LangChain error code, when the failure came from the model call. */
  code?: string;
  /** Set when the provider told us when capacity returns. */
  retryAt?: string;
  message: string;
};

/**
 * Reads `lc_error_code`, following `cause` links.
 *
 * A graph node may re-throw a model error wrapped in its own Error, which
 * leaves the code on the cause rather than the outer error.
 */
function readLangChainErrorCode(value: unknown): string | null {
  let current = value;
  // Bounded walk: cause chains are short, and a cycle must not hang the run.
  for (let depth = 0; current && typeof current === 'object' && depth < 10; depth += 1) {
    const record = current as { lc_error_code?: unknown; cause?: unknown };
    if (typeof record.lc_error_code === 'string' && record.lc_error_code) {
      return record.lc_error_code;
    }
    current = record.cause;
  }
  return null;
}

function readErrorMessage(value: unknown): string {
  if (value instanceof Error) return value.message;
  if (value && typeof value === 'object') {
    const record = value as { message?: unknown };
    if (typeof record.message === 'string') return record.message;
  }
  return String(value ?? '');
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

/**
 * Classifies a thrown run error.
 *
 * Only a model-call failure carrying a fatal LangChain error code terminates a
 * pending review. Everything else stays `recoverable`: wrongly terminating a
 * resolvable review discards a decision the user still owns, which is the more
 * expensive mistake.
 */
export function classifyAgentRunFailure(value: unknown): AgentRunFailure {
  const message = readErrorMessage(value);
  const code = readLangChainErrorCode(value);

  if (!code || !FATAL_MODEL_ERROR_CODES.has(code)) {
    return { kind: 'recoverable', message };
  }
  const retryAt = readRetryAt(message);
  return {
    kind: 'fatal',
    code,
    ...(retryAt ? { retryAt } : {}),
    message,
  };
}

export function isFatalAgentRunError(value: unknown): boolean {
  return classifyAgentRunFailure(value).kind === 'fatal';
}

/** User-facing explanation for a terminated run, in the TUI's language. */
export function describeFatalAgentRunFailure(failure: AgentRunFailure): string {
  const cause = failure.code === 'MODEL_AUTHENTICATION'
    ? '模型认证失败，请检查 API key 配置。'
    : failure.code === 'MODEL_NOT_FOUND'
      ? '配置的模型不存在，请检查模型名称。'
      : failure.retryAt
        ? `模型额度将于 ${failure.retryAt} 恢复。`
        : '模型额度已耗尽。';
  return `${failure.message}\n\n${cause}已终止本次运行并关闭待确认的操作，恢复后请重新发起对话。`;
}
