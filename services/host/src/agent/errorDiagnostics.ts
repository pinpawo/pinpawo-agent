import type { AgentErrorDiagnostics } from '@pinpawo/agent-session';

function property(value: object, key: string): unknown {
  try { return (value as Record<string, unknown>)[key]; } catch { return undefined; }
}

const MAX_CHAIN = 4;
const MAX_WALK = 16;

function sameEntry(a: AgentErrorDiagnostics['chain'][number], b: AgentErrorDiagnostics['chain'][number]) {
  return a.name === b.name && a.code === b.code && a.status === b.status;
}

/**
 * Classification, never arbitrary error messages, URLs, headers or payloads.
 * Wrappers that repeat their cause's classification (LangChain's
 * MiddlewareError keeps the wrapped name) collapse into one entry, and a long
 * chain keeps its root so the deepest cause is never the one dropped.
 */
export function describeAgentError(error: unknown): AgentErrorDiagnostics {
  const chain: AgentErrorDiagnostics['chain'] = [];
  const seen = new Set<object>();
  let current = error;
  let walked = 0;
  while (current && typeof current === 'object' && !seen.has(current) && walked < MAX_WALK) {
    walked += 1;
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
    const entry = { name, ...(code ? { code } : {}), ...(status !== undefined ? { status } : {}) };
    if (!chain.length || !sameEntry(chain[chain.length - 1], entry)) chain.push(entry);
    current = property(current, 'cause');
  }
  if (!chain.length) return { chain: [{ name: 'Error' }] };
  return { chain: chain.length > MAX_CHAIN ? [...chain.slice(0, MAX_CHAIN - 1), chain[chain.length - 1]] : chain };
}
