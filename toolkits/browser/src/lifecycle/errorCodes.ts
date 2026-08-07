/**
 * Structured error codes for Browser Runtime operations.
 *
 * These extend the toolkit's error surface so callers can distinguish a real
 * navigation failure from a mid-flight timeout, an origin redirect, a restricted
 * target, a user interaction requirement, and so on. `retryable` is decided per
 * instance: deterministic permission errors are never retried for a full
 * deadline, while transient resource loss may be.
 */

export const BROWSER_RUNTIME_ERROR_CODES = [
  'navigation_failed',
  'navigation_settle_timeout',
  'origin_changed',
  'restricted_target',
  'target_closed',
  'target_crashed',
  'debugger_detached',
  'runtime_disconnected',
  'requires_user_action',
  'browser_command_cancelled',
  'navigation_timeout',
] as const;

export type BrowserRuntimeErrorCode = typeof BROWSER_RUNTIME_ERROR_CODES[number];

export type StructuredBrowserError = {
  code: BrowserRuntimeErrorCode;
  message: string;
  retryable: boolean;
  details?: Record<string, unknown>;
};
