import type { ReviewEffect } from './reviewSpec';
import {
  readToolAuthorizationMatcher,
  toolAuthorizationMatcherKey,
  toolAuthorizationMatchersEqual,
  type ToolAuthorizationMatcher,
} from './authorizationMatchers';

export {
  exactAuthorization,
  readToolAuthorizationMatcher,
  toolAuthorizationMatcherKey,
  toolAuthorizationMatchersEqual,
  urlOriginAuthorization,
} from './authorizationMatchers';
export type { ToolAuthorizationMatcher } from './authorizationMatchers';

export type ToolAuthorizationSource = 'human' | 'auto_review';

export type ToolAuthorizationRecord = {
  toolName: string;
  matcher: ToolAuthorizationMatcher;
  createdAt: string;
  source: ToolAuthorizationSource;
};

export type ApplyReviewEffectsOptions = {
  toolName: string;
  matcher: ToolAuthorizationMatcher | null;
  effects: ReviewEffect[];
  now?: () => Date;
};

export type ReviewEffectApplicationErrorCode =
  | 'missing_thread'
  | 'unsupported_effect'
  | 'missing_policy_matcher'
  | 'invalid_matcher';

export class ReviewEffectApplicationError extends Error {
  readonly code: ReviewEffectApplicationErrorCode;

  constructor(code: ReviewEffectApplicationErrorCode, message: string) {
    super(message);
    this.name = 'ReviewEffectApplicationError';
    this.code = code;
  }
}

function assertToolAuthorizationMatcher(value: unknown, source: string): ToolAuthorizationMatcher {
  const matcher = readToolAuthorizationMatcher(value);
  if (!matcher) {
    throw new ReviewEffectApplicationError(
      'invalid_matcher',
      `${source} must produce a supported authorization matcher.`,
    );
  }
  return matcher;
}

function readToolAuthorizationSource(value: unknown): ToolAuthorizationSource | null {
  return value === 'human' || value === 'auto_review' ? value : null;
}

function normalizeToolAuthorizationRecord(
  value: unknown,
): ToolAuthorizationRecord | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  const matcher = readToolAuthorizationMatcher(record.matcher);
  const source = readToolAuthorizationSource(record.source);
  if (
    !matcher
    || !source
    || typeof record.toolName !== 'string'
    || !record.toolName.trim()
    || typeof record.createdAt !== 'string'
    || !record.createdAt
  ) {
    return null;
  }
  return {
    toolName: record.toolName,
    matcher,
    createdAt: record.createdAt,
    source,
  };
}

export const readToolAuthorizationRecord = normalizeToolAuthorizationRecord;

export function toolAuthorizationRecordKey(rule: ToolAuthorizationRecord) {
  return `${rule.toolName}:${toolAuthorizationMatcherKey(rule.matcher)}`;
}

export function buildToolAuthorizationRecord(params: {
  toolName: string;
  matcher: ToolAuthorizationMatcher;
  source: ToolAuthorizationSource;
  now?: () => Date;
}): ToolAuthorizationRecord {
  const matcher = assertToolAuthorizationMatcher(params.matcher, 'authorizeToolAction');
  const createdAt = (params.now ?? (() => new Date()))().toISOString();
  return {
    toolName: params.toolName,
    matcher,
    createdAt,
    source: params.source,
  };
}

export const authorizeToolAction = buildToolAuthorizationRecord;

export function findToolAuthorization(params: {
  authorizations: ToolAuthorizationRecord[];
  toolName: string;
  candidateMatcher: ToolAuthorizationMatcher;
}) {
  return params.authorizations.find((rule) => {
    const normalized = normalizeToolAuthorizationRecord(rule);
    return Boolean(
      normalized
      && normalized.toolName === params.toolName
      && toolAuthorizationMatchersEqual(normalized.matcher, params.candidateMatcher),
    );
  });
}

export function isToolActionAuthorized(params: {
  authorizations: ToolAuthorizationRecord[];
  toolName: string;
  candidateMatcher: ToolAuthorizationMatcher;
}) {
  return Boolean(findToolAuthorization(params));
}

export function mergeToolAuthorizations(
  current: ToolAuthorizationRecord[] | null | undefined,
  next: ToolAuthorizationRecord[],
) {
  const merged: ToolAuthorizationRecord[] = [];
  const indexes = new Map<string, number>();

  for (const rule of [...(current ?? []), ...next]) {
    const normalized = normalizeToolAuthorizationRecord(rule);
    if (!normalized) {
      continue;
    }
    const key = toolAuthorizationRecordKey(normalized);
    const existingIndex = indexes.get(key);
    if (existingIndex !== undefined) {
      const existing = merged[existingIndex]!;
      if (existing.source === 'auto_review' && normalized.source === 'human') {
        merged[existingIndex] = normalized;
      }
      continue;
    }
    indexes.set(key, merged.length);
    merged.push(normalized);
  }

  return merged;
}

export async function applyReviewEffects(options: ApplyReviewEffectsOptions) {
  const applied: ToolAuthorizationRecord[] = [];
  for (const effect of options.effects) {
    if (
      effect.type !== 'graph.authorize_tool_action'
      || effect.scope !== 'thread'
    ) {
      throw new ReviewEffectApplicationError(
        'unsupported_effect',
        `Unsupported review effect "${(effect as { type?: string }).type ?? 'unknown'}".`,
      );
    }
    if (!options.matcher) {
      throw new ReviewEffectApplicationError(
        'missing_policy_matcher',
        `Tool "${options.toolName}" did not produce an authorization matcher.`,
      );
    }
    applied.push(buildToolAuthorizationRecord({
      toolName: options.toolName,
      matcher: options.matcher,
      source: 'human',
      now: options.now,
    }));
  }
  return applied;
}
