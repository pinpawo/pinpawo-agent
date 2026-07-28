import type { AgentToolkit, ToolReviewPolicy } from '../../../types/toolkit';
import type {
  PendingReviewAction,
  ReviewEffect,
  ToolAuthorizationMatcher,
  ToolAuthorizationMatcherTemplate,
} from './reviewSpec';

export type ToolAuthorizationRecord = {
  toolName: string;
  matcher: ToolAuthorizationMatcher;
  createdAt: string;
  /**
   * Omitted records predate source tracking and are treated as human grants.
   * Auto-review grants are valid only while auto authorization is active.
   */
  source?: ToolAuthorizationSource;
};

export type ToolAuthorizationSource = 'human' | 'auto_review';

export type ApplyReviewEffectsOptions = {
  pendingAction: PendingReviewAction;
  effects: ReviewEffect[];
  toolkits: AgentToolkit[];
  now?: () => Date;
};

export type ReviewEffectApplicationErrorCode =
  | 'missing_thread'
  | 'missing_pending_action'
  | 'unsupported_effect'
  | 'unsupported_action_ref'
  | 'missing_policy_hook'
  | 'missing_policy_matcher'
  | 'invalid_matcher'
  | 'invalid_matcher_source';

export class ReviewEffectApplicationError extends Error {
  readonly code: ReviewEffectApplicationErrorCode;

  constructor(code: ReviewEffectApplicationErrorCode, message: string) {
    super(message);
    this.name = 'ReviewEffectApplicationError';
    this.code = code;
  }
}

export function normalizeShellPattern(pattern: string) {
  return pattern.replace(/\s+/g, ' ').trim();
}

function readRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

export function readToolAuthorizationMatcher(value: unknown): ToolAuthorizationMatcher | null {
  const record = readRecord(value);
  if (!record) {
    return null;
  }

  if (record.type === 'shell_pattern') {
    const pattern = typeof record.value === 'string'
      ? normalizeShellPattern(record.value)
      : '';
    return pattern ? { type: 'shell_pattern', value: pattern } : null;
  }

  if (record.type === 'exact_args') {
    const args = readRecord(record.value);
    return args ? { type: 'exact_args', value: { ...args } } : null;
  }

  if (record.type === 'url_domain') {
    const domain = readUrlDomainValue(record.value);
    return domain ? { type: 'url_domain', value: domain } : null;
  }

  return null;
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

function wildcardToRegExp(pattern: string) {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${escaped}$`);
}

function readShellCommand(args: Record<string, unknown>) {
  const command = args.command;
  return typeof command === 'string' ? normalizeShellPattern(command) : '';
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

function readUrlDomainValue(value: unknown) {
  const record = readRecord(value);
  if (!record) return null;
  const origin = normalizeUrlOrigin(record.origin);
  return origin ? { origin } : null;
}

function readUrlOrigin(args: Record<string, unknown>) {
  return normalizeUrlOrigin(args.url);
}

function stableJson(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return JSON.stringify(value);
  }
  const record = value as Record<string, unknown>;
  return JSON.stringify(
    Object.keys(record)
      .sort()
      .reduce<Record<string, unknown>>((acc, key) => {
        acc[key] = record[key];
        return acc;
      }, {}),
  );
}

function toolAuthorizationKey(rule: ToolAuthorizationRecord) {
  const matcher = readToolAuthorizationMatcher(rule.matcher);
  if (!matcher) {
    return null;
  }
  if (matcher.type === 'shell_pattern') {
    return `${rule.toolName}:shell_pattern:${matcher.value}`;
  }
  if (matcher.type === 'url_domain') {
    return `${rule.toolName}:url_domain:${matcher.value.origin}`;
  }
  return `${rule.toolName}:exact_args:${stableJson(matcher.value)}`;
}

function matchesAuthorizationRule(rule: ToolAuthorizationRecord, params: {
  toolName: string;
  args: Record<string, unknown>;
}) {
  if (rule.toolName !== params.toolName) {
    return false;
  }

  if (rule.matcher.type === 'shell_pattern') {
    const command = readShellCommand(params.args);
    if (!command) return false;
    const pattern = normalizeShellPattern(rule.matcher.value);
    if (!pattern) return false;
    if (pattern === command) return true;
    if (pattern.includes('*')) {
      return wildcardToRegExp(pattern).test(command);
    }
    return false;
  }

  if (rule.matcher.type === 'url_domain') {
    const origin = readUrlOrigin(params.args);
    return Boolean(origin) && origin === rule.matcher.value.origin;
  }

  return stableJson(rule.matcher.value) === stableJson(params.args);
}

export function buildToolAuthorizationRecord(params: {
  toolName: string;
  matcher: ToolAuthorizationMatcher;
  source?: ToolAuthorizationSource;
  now?: () => Date;
}): ToolAuthorizationRecord {
  const matcher = assertToolAuthorizationMatcher(params.matcher, 'authorizeToolAction');
  const createdAt = (params.now ?? (() => new Date()))().toISOString();
  return {
    toolName: params.toolName,
    matcher,
    createdAt,
    ...(params.source ? { source: params.source } : {}),
  };
}

export const authorizeToolAction = buildToolAuthorizationRecord;

export function isToolActionAuthorized(params: {
  authorizations: ToolAuthorizationRecord[];
  toolName: string;
  args: Record<string, unknown>;
}) {
  return params.authorizations.some((rule) =>
    matchesAuthorizationRule(rule, {
      toolName: params.toolName,
      args: params.args,
    }),
  );
}

export function mergeToolAuthorizations(
  current: ToolAuthorizationRecord[] | null | undefined,
  next: ToolAuthorizationRecord[],
) {
  const merged: ToolAuthorizationRecord[] = [];
  const indexes = new Map<string, number>();

  for (const rule of [...(current ?? []), ...next]) {
    const matcher = readToolAuthorizationMatcher(rule.matcher);
    if (!matcher) {
      continue;
    }
    const normalized = { ...rule, matcher };
    const key = toolAuthorizationKey(normalized);
    if (!key) {
      continue;
    }
    const existingIndex = indexes.get(key);
    if (existingIndex !== undefined) {
      const existing = merged[existingIndex]!;
      if (existing.source === 'auto_review' && normalized.source !== 'auto_review') {
        merged[existingIndex] = normalized;
      }
      continue;
    }
    indexes.set(key, merged.length);
    merged.push(normalized);
  }

  return merged;
}

function findReviewPolicy(toolkits: AgentToolkit[], toolName: string): {
  toolkit: AgentToolkit;
  toolkitName: string;
  policy: ToolReviewPolicy;
  operation: AgentToolkit['tools'][number]['operation'];
} | null {
  for (const toolkit of toolkits) {
    const definition = toolkit.tools.find((item) => item.tool.name === toolName);
    if (definition?.review) {
      return {
        toolkit,
        toolkitName: toolkit.name,
        policy: definition.review,
        operation: definition.operation,
      };
    }
  }
  return null;
}

async function buildMatcherFromTemplate(params: {
  effect: Extract<ReviewEffect, { type: 'graph.authorize_tool_action' }>;
  matcher: ToolAuthorizationMatcherTemplate;
  pendingAction: PendingReviewAction;
  toolkits: AgentToolkit[];
}): Promise<ToolAuthorizationMatcher> {
  if (params.matcher.type === 'shell_pattern') {
    const command = readShellCommand(params.pendingAction.args);
    if (!command) {
      throw new ReviewEffectApplicationError(
        'invalid_matcher_source',
        'Cannot build shell authorization matcher without args.command.',
      );
    }
    return { type: 'shell_pattern', value: command };
  }

  if (params.matcher.type === 'exact_args') {
    return { type: 'exact_args', value: { ...params.pendingAction.args } };
  }

  if (params.matcher.type === 'url_domain') {
    const origin = readUrlOrigin(params.pendingAction.args);
    if (!origin) {
      throw new ReviewEffectApplicationError(
        'invalid_matcher_source',
        'Cannot build URL domain authorization matcher without args.url.',
      );
    }
    return { type: 'url_domain', value: { origin } };
  }

  const policyRef = findReviewPolicy(params.toolkits, params.pendingAction.toolName);
  const buildAuthorizationMatcher = policyRef?.policy.buildAuthorizationMatcher;
  if (!policyRef || !buildAuthorizationMatcher) {
    throw new ReviewEffectApplicationError(
      'missing_policy_hook',
      `Tool "${params.pendingAction.toolName}" does not declare an authorization matcher hook.`,
    );
  }
  const matcher = await buildAuthorizationMatcher({
    toolkitName: policyRef.toolkitName,
    toolName: params.pendingAction.toolName,
    input: params.pendingAction.args,
    operation: policyRef.operation,
    pendingAction: params.pendingAction,
    effect: params.effect,
  });
  if (!matcher) {
    throw new ReviewEffectApplicationError(
      'missing_policy_matcher',
      `Tool "${params.pendingAction.toolName}" did not return an authorization matcher.`,
    );
  }
  return assertToolAuthorizationMatcher(
    matcher,
    `Tool "${params.pendingAction.toolName}" authorization matcher hook`,
  );
}

export async function applyReviewEffects(options: ApplyReviewEffectsOptions) {
  const applied: ToolAuthorizationRecord[] = [];
  for (const effect of options.effects) {
    if (effect.type !== 'graph.authorize_tool_action') {
      throw new ReviewEffectApplicationError(
        'unsupported_effect',
        `Unsupported review effect "${(effect as { type?: string }).type ?? 'unknown'}".`,
      );
    }
    if (effect.actionRef.type !== 'pending_action') {
      throw new ReviewEffectApplicationError(
        'unsupported_action_ref',
        `Unsupported actionRef "${(effect.actionRef as { type?: string }).type ?? 'unknown'}".`,
      );
    }

    const matcher = await buildMatcherFromTemplate({
      effect,
      matcher: effect.matcher,
      pendingAction: options.pendingAction,
      toolkits: options.toolkits,
    });
    const rule = buildToolAuthorizationRecord({
      toolName: options.pendingAction.toolName,
      matcher,
      source: 'human',
      now: options.now,
    });
    applied.push(rule);
  }
  return applied;
}
