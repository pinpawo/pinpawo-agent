import type { AgentToolkit, ToolkitToolReviewPolicy } from '../../../types/toolkit';
import type {
  PendingReviewAction,
  ReviewEffect,
  ToolAuthorizationMatcher,
  ToolAuthorizationMatcherTemplate,
} from './reviewSpec';

export type ToolAuthorizationRule = {
  threadId: string;
  toolName: string;
  matcher: ToolAuthorizationMatcher;
  createdAt: string;
};

export type ApplyReviewEffectsOptions = {
  threadId: string | null | undefined;
  pendingAction: PendingReviewAction;
  effects: ReviewEffect[];
  toolkits: AgentToolkit[];
  now?: () => Date;
};

export type ReviewEffectApplicationErrorCode =
  | 'missing_thread'
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

const threadAuthorizations = new Map<string, ToolAuthorizationRule[]>();

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

function matchesAuthorizationRule(rule: ToolAuthorizationRule, params: {
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

  return stableJson(rule.matcher.value) === stableJson(params.args);
}

export function authorizeToolAction(params: {
  threadId: string | null | undefined;
  toolName: string;
  matcher: ToolAuthorizationMatcher;
  now?: () => Date;
}): ToolAuthorizationRule | null {
  const threadId = params.threadId?.trim();
  if (!threadId) {
    return null;
  }
  const matcher = assertToolAuthorizationMatcher(params.matcher, 'authorizeToolAction');
  const createdAt = (params.now ?? (() => new Date()))().toISOString();
  const rule: ToolAuthorizationRule = {
    threadId,
    toolName: params.toolName,
    matcher,
    createdAt,
  };
  const rules = threadAuthorizations.get(threadId) ?? [];
  rules.push(rule);
  threadAuthorizations.set(threadId, rules);
  return rule;
}

export function isToolActionAuthorized(params: {
  threadId: string | null | undefined;
  toolName: string;
  args: Record<string, unknown>;
}) {
  const threadId = params.threadId?.trim();
  if (!threadId) {
    return false;
  }
  return (threadAuthorizations.get(threadId) ?? []).some((rule) =>
    matchesAuthorizationRule(rule, {
      toolName: params.toolName,
      args: params.args,
    }),
  );
}

export function clearToolAuthorizations(threadId: string | null | undefined) {
  const key = threadId?.trim();
  if (key) {
    threadAuthorizations.delete(key);
  }
}

function findReviewPolicy(toolkits: AgentToolkit[], toolName: string): {
  toolkitName: string;
  policy: ToolkitToolReviewPolicy;
} | null {
  for (const toolkit of toolkits) {
    const policy = toolkit.policy?.toolReview?.[toolName];
    if (policy) {
      return {
        toolkitName: toolkit.name,
        policy,
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
  const threadId = options.threadId?.trim();
  if (!threadId && options.effects.length > 0) {
    throw new ReviewEffectApplicationError(
      'missing_thread',
      'Cannot apply review effects without a graph thread id.',
    );
  }

  const applied: ToolAuthorizationRule[] = [];
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
    const rule = authorizeToolAction({
      threadId,
      toolName: options.pendingAction.toolName,
      matcher,
      now: options.now,
    });
    if (rule) {
      applied.push(rule);
    }
  }
  return applied;
}
