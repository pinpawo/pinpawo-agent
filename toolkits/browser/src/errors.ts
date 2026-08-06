export type BrowserErrorCode =
  | 'browser_not_open'
  | 'browser_context_missing'
  | 'browser_context_conflict'
  | 'browser_timeout'
  | 'stale_element_reference'
  | 'target_closed'
  | 'origin_changed'
  | 'browser_operation_failed'
  | string;

export type BrowserErrorPayload = {
  code: BrowserErrorCode;
  message: string;
  retryable: boolean;
  details?: Record<string, unknown>;
};

export class BrowserOperationError extends Error {
  constructor(
    public readonly code: BrowserErrorCode,
    message: string,
    public readonly retryable = false,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'BrowserOperationError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function normalizeBrowserError(error: unknown): BrowserErrorPayload {
  if (isRecord(error) && typeof error.code === 'string') {
    return {
      code: error.code,
      message: error instanceof Error ? error.message : String(error.message ?? error.code),
      retryable: error.retryable === true,
      ...(isRecord(error.details) ? { details: error.details } : {}),
    };
  }

  const message = error instanceof Error ? error.message : String(error);
  const normalized = message.toLowerCase();
  if (normalized.includes('stale') && normalized.includes('reference')) {
    return { code: 'stale_element_reference', message, retryable: true };
  }
  if (
    normalized.includes('target closed')
    || normalized.includes('page has been closed')
    || normalized.includes('context has been closed')
  ) {
    return { code: 'target_closed', message, retryable: true };
  }
  if (normalized.includes('no active browser') || normalized.includes('use browser_open first')) {
    return { code: 'browser_not_open', message, retryable: true };
  }
  if (
    (error instanceof Error && error.name === 'TimeoutError')
    || normalized.includes('timeout')
    || normalized.includes('timed out')
  ) {
    return { code: 'browser_timeout', message, retryable: true };
  }
  return { code: 'browser_operation_failed', message, retryable: false };
}

export function formatBrowserToolError(error: unknown): string {
  return JSON.stringify({
    ok: false,
    error: normalizeBrowserError(error),
  }, null, 2);
}
