type ShellAuthorizationRule = {
  pattern: string;
  createdAt: string;
};

const shellAuthorizations = new Map<string, ShellAuthorizationRule[]>();

function normalizePattern(pattern: string) {
  return pattern.replace(/\s+/g, ' ').trim();
}

function wildcardToRegExp(pattern: string) {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^${escaped.replace(/\*/g, '.*').replace(/\?/g, '.')}$`);
}

export function authorizeShellPattern(threadId: string, pattern: string) {
  const normalized = normalizePattern(pattern);
  if (!normalized) return null;

  const current = shellAuthorizations.get(threadId) ?? [];
  if (!current.some((rule) => rule.pattern === normalized)) {
    current.push({
      pattern: normalized,
      createdAt: new Date().toISOString(),
    });
    shellAuthorizations.set(threadId, current);
  }
  return normalized;
}

export function isShellCommandAuthorized(threadId: string, command: string) {
  const normalizedCommand = normalizePattern(command);
  const rules = shellAuthorizations.get(threadId) ?? [];
  return rules.some((rule) => wildcardToRegExp(rule.pattern).test(normalizedCommand));
}

export function clearSessionAuthorizations(threadId: string) {
  shellAuthorizations.delete(threadId);
}
