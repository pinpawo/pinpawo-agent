/**
 * Detects LangGraph's `GraphRecursionError` (raised when a graph hits its
 * `recursionLimit` without a stop condition). Matches both the structured
 * `lc_error_code` and the message text, since the code is not always present
 * depending on how the error propagates / is re-wrapped.
 */
export function isGraphRecursionLimitError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  const lcCode = (error as { lc_error_code?: unknown }).lc_error_code;
  if (typeof lcCode === 'string' && lcCode === 'GRAPH_RECURSION_LIMIT') {
    return true;
  }
  return /GRAPH_RECURSION_LIMIT|Recursion limit of \d+ reached/i.test(error.message);
}
