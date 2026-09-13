import { createHash } from 'node:crypto';

const EXACT_AUTHORIZATION_KEY_PREFIX = 'exact:v1:sha256:';

export type ToolAuthorizationMatcher =
  | {
      type: 'exact';
      key: string;
    }
  | {
      type: 'url_origin';
      origin: string;
    };

const policyGenerationKeys = new WeakMap<object, string>();

/**
 * Attach a stable registry-generation input to a framework authorization
 * policy without making it part of the matcher or persisted grant.
 */
export function markAuthorizationPolicyGeneration<T extends object>(
  policy: T,
  key: string,
): T {
  policyGenerationKeys.set(policy, key);
  return policy;
}

export function readAuthorizationPolicyGeneration(policy: object): string | null {
  return policyGenerationKeys.get(policy) ?? null;
}

function readRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null
    ? value as Record<string, unknown>
    : null;
}

function canonicalJson(value: unknown, ancestors = new Set<object>()): string {
  if (value === null) {
    return 'null';
  }
  if (typeof value === 'string' || typeof value === 'boolean') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new TypeError('Exact authorization subjects cannot contain non-finite numbers.');
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    if (ancestors.has(value)) {
      throw new TypeError('Exact authorization subjects cannot contain circular references.');
    }
    ancestors.add(value);
    try {
      return `[${value.map((item) => canonicalJson(item, ancestors)).join(',')}]`;
    } finally {
      ancestors.delete(value);
    }
  }
  const record = readRecord(value);
  if (!record) {
    throw new TypeError('Exact authorization subjects must contain only JSON values.');
  }
  if (ancestors.has(record)) {
    throw new TypeError('Exact authorization subjects cannot contain circular references.');
  }
  ancestors.add(record);
  try {
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key], ancestors)}`)
      .join(',')}}`;
  } finally {
    ancestors.delete(record);
  }
}

function normalizeUrlOrigin(value: unknown) {
  if (typeof value !== 'string') return '';
  try {
    const origin = new URL(value).origin;
    return origin === 'null' ? '' : origin;
  } catch {
    return '';
  }
}

export function exactAuthorization(subject: unknown): ToolAuthorizationMatcher {
  const digest = createHash('sha256')
    .update(canonicalJson(subject))
    .digest('hex');
  return {
    type: 'exact',
    key: `${EXACT_AUTHORIZATION_KEY_PREFIX}${digest}`,
  };
}

export function urlOriginAuthorization(value: unknown): ToolAuthorizationMatcher | null {
  const origin = normalizeUrlOrigin(value);
  return origin ? { type: 'url_origin', origin } : null;
}

export function readToolAuthorizationMatcher(value: unknown): ToolAuthorizationMatcher | null {
  const record = readRecord(value);
  if (!record) {
    return null;
  }
  if (
    record.type === 'exact'
    && typeof record.key === 'string'
    && record.key.startsWith(EXACT_AUTHORIZATION_KEY_PREFIX)
    && /^[a-f0-9]{64}$/.test(record.key.slice(EXACT_AUTHORIZATION_KEY_PREFIX.length))
  ) {
    return { type: 'exact', key: record.key };
  }
  if (record.type === 'url_origin') {
    const matcher = urlOriginAuthorization(record.origin);
    return matcher?.type === 'url_origin' ? matcher : null;
  }
  return null;
}

export function toolAuthorizationMatcherKey(matcher: ToolAuthorizationMatcher) {
  return matcher.type === 'exact'
    ? matcher.key
    : `url_origin:${matcher.origin}`;
}

export function toolAuthorizationMatchersEqual(
  left: ToolAuthorizationMatcher,
  right: ToolAuthorizationMatcher,
) {
  return left.type === right.type
    && toolAuthorizationMatcherKey(left) === toolAuthorizationMatcherKey(right);
}
