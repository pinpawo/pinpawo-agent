import type { AgentErrorDiagnostics } from '@pinpawo/agent-session';

function property(value: object, key: string): unknown {
  try { return (value as Record<string, unknown>)[key]; } catch { return undefined; }
}

/** Classification, never arbitrary error messages, URLs, headers or payloads. */
export function describeAgentError(error: unknown): AgentErrorDiagnostics {
  const chain: AgentErrorDiagnostics['chain'] = [];
  const seen = new Set<object>();
  let current = error;
  while (current && typeof current === 'object' && !seen.has(current) && chain.length < 4) {
    seen.add(current);
    const rawName = property(current, 'name');
    const name = typeof rawName === 'string' && /^(?:Error|[A-Za-z][A-Za-z0-9]{0,47}(?:Error|Exception))$/.test(rawName)
      ? rawName : 'Error';
    const rawCode = property(current, 'code');
    const code = typeof rawCode === 'string'
      && /^(?:E[A-Z0-9_]{1,31}|UND_ERR_[A-Z0-9_]{1,40}|rate_limit_exceeded|insufficient_quota|invalid_api_key|context_length_exceeded|invalid_request_error|server_error)$/.test(rawCode)
      ? rawCode : undefined;
    const rawStatus = property(current, 'status');
    const status = typeof rawStatus === 'number' && Number.isInteger(rawStatus) && rawStatus >= 100 && rawStatus <= 599
      ? rawStatus : undefined;
    chain.push({ name, ...(code ? { code } : {}), ...(status !== undefined ? { status } : {}) });
    current = property(current, 'cause');
  }
  return { chain: chain.length ? chain : [{ name: 'Error' }] };
}
