import type {
  ToolOperationSummary,
  ToolkitToolReviewBlock,
  ToolkitToolReviewContext,
  ToolkitToolReviewPolicy,
} from '../../../types/toolkit';
import { isToolActionAuthorized } from './reviewAuthorizations';
import {
  buildReviewSpec,
  type ReviewOption,
  type ReviewView,
  type ToolAuthorizationMatcher,
  type ToolAuthorizationMatcherTemplate,
} from './reviewSpec';

export type ReviewUnavailableBehavior = 'block' | 'allow';
export type AuthorizationMode = 'none' | 'exact_args' | 'url_domain';

export type HitlPresetOptions = {
  authorization?: AuthorizationMode;
  unavailable?: ReviewUnavailableBehavior;
};

type PresetOptions = HitlPresetOptions & {
  requiresHitl: boolean;
  defaultUnavailable: ReviewUnavailableBehavior;
  defaultAuthorization: AuthorizationMode;
};

const DEFAULT_DETAILS_LIMIT = 4_000;

function inputToRecord(input: unknown): Record<string, unknown> {
  return input && typeof input === 'object' && !Array.isArray(input)
    ? { ...(input as Record<string, unknown>) }
    : { input };
}

function truncate(value: string, limit = DEFAULT_DETAILS_LIMIT) {
  return value.length <= limit
    ? value
    : `${value.slice(0, limit)}\n[truncated ${(value.length - limit).toString()} chars]`;
}

function readOperationSummary(ctx: ToolkitToolReviewContext): ToolOperationSummary | null {
  try {
    return ctx.operation?.summarizeInput?.(ctx.input) ?? null;
  } catch {
    return null;
  }
}

function formatDetails(details: Record<string, unknown> | undefined) {
  if (!details || Object.keys(details).length === 0) {
    return null;
  }
  return truncate(JSON.stringify(details, null, 2));
}

function formatInput(input: unknown) {
  try {
    return truncate(JSON.stringify(inputToRecord(input), null, 2));
  } catch {
    return truncate(String(input));
  }
}

function buildReviewBody(ctx: ToolkitToolReviewContext, summary: ToolOperationSummary | null) {
  const details = formatDetails(summary?.details);
  const lines = [
    summary?.summary ? `Summary: ${summary.summary}` : null,
    summary?.target ? `Target: ${summary.target}` : null,
    details ? `Details:\n${details}` : null,
  ].filter((line): line is string => Boolean(line));

  return lines.length > 0
    ? lines.join('\n\n')
    : `Input:\n${formatInput(ctx.input)}`;
}

function readPatchDetail(summary: ToolOperationSummary | null): string | null {
  const patch = summary?.details?.patch;
  return typeof patch === 'string' && patch.trim() ? patch : null;
}

function buildReviewView(
  ctx: ToolkitToolReviewContext,
  summary: ToolOperationSummary | null,
): ReviewView {
  const title = buildReviewTitle(ctx);
  const patch = readPatchDetail(summary);
  if (patch) {
    return {
      kind: 'diff',
      title,
      patch,
      ...(summary?.target ? { target: summary.target } : {}),
      ...(summary?.summary ? { summary: summary.summary } : {}),
    };
  }
  return {
    kind: 'plain',
    title,
    body: buildReviewBody(ctx, summary),
  };
}

function buildReviewTitle(ctx: ToolkitToolReviewContext) {
  return ctx.operation?.title ?? ctx.toolName;
}

export function buildStandardReviewOptions(params: {
  authorizeMatcher?: ToolAuthorizationMatcherTemplate;
  authorizeDescription?: string;
} = {}): ReviewOption[] {
  return [
    {
      id: 'approve',
      label: 'Approve',
      variant: 'primary',
      decision: { type: 'approve' },
    },
    ...(params.authorizeMatcher ? [{
      id: 'approve-and-authorize-thread',
      label: 'Approve and authorize',
      description: params.authorizeDescription
        ?? 'Approve this action and authorize exact matching arguments in this thread.',
      decision: { type: 'approve' as const },
      effects: [{
        type: 'graph.authorize_tool_action' as const,
        scope: 'thread' as const,
        actionRef: { type: 'pending_action' as const },
        matcher: params.authorizeMatcher,
      }],
    }] : []),
    {
      id: 'reject',
      label: 'Reject',
      variant: 'danger',
      decision: { type: 'reject' },
    },
    {
      id: 'respond',
      label: 'Respond',
      input: {
        kind: 'text',
        key: 'message',
        required: true,
        multiline: true,
        placeholder: 'Tell the agent what to do instead',
      },
      decision: { type: 'respond', messageInputKey: 'message' },
    },
  ];
}

function buildExactArgsMatcher(ctx: { input: unknown }): ToolAuthorizationMatcher {
  return {
    type: 'exact_args',
    value: inputToRecord(ctx.input),
  };
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

function buildUrlDomainMatcher(ctx: { input: unknown }): ToolAuthorizationMatcher | null {
  const input = inputToRecord(ctx.input);
  const origin = normalizeUrlOrigin(input.url);
  return origin
    ? { type: 'url_domain', value: { origin } }
    : null;
}

function buildAuthorizationMatcher(mode: AuthorizationMode, ctx: { input: unknown }) {
  if (mode === 'exact_args') {
    return buildExactArgsMatcher(ctx);
  }
  if (mode === 'url_domain') {
    return buildUrlDomainMatcher(ctx);
  }
  return null;
}

function authorizationDescription(matcher: ToolAuthorizationMatcher) {
  if (matcher.type === 'url_domain') {
    return 'Approve this action and authorize the same URL domain in this thread.';
  }
  return 'Approve this action and authorize exact matching arguments in this thread.';
}

function blockReview(ctx: ToolkitToolReviewContext): ToolkitToolReviewBlock {
  return {
    type: 'block',
    reason: `Human review is required before running ${ctx.toolName}, but this runtime does not support HITL.`,
  };
}

function createPresetPolicy(options: PresetOptions): ToolkitToolReviewPolicy {
  const authorization = options.authorization ?? options.defaultAuthorization;
  const unavailable = options.unavailable ?? options.defaultUnavailable;

  return {
    request: (ctx) => {
      if (!options.requiresHitl) {
        return null;
      }

      const capabilities = ctx.reviewCapabilities ?? {
        humanReview: false,
        sessionAuthorization: false,
      };

      const matcher = buildAuthorizationMatcher(authorization, ctx);

      if (matcher && capabilities.sessionAuthorization) {
        const args = matcher.type === 'exact_args' ? matcher.value : inputToRecord(ctx.input);
        if (isToolActionAuthorized({
          authorizations: ctx.toolAuthorizations ?? [],
          toolName: ctx.toolName,
          args,
        })) {
          return null;
        }
      }

      if (!capabilities.humanReview) {
        return unavailable === 'block'
          ? blockReview(ctx)
          : null;
      }

      const summary = readOperationSummary(ctx);
      return buildReviewSpec({
        view: buildReviewView(ctx, summary),
        options: buildStandardReviewOptions({
          authorizeMatcher: matcher && capabilities.sessionAuthorization
            ? { type: 'policy_hook' }
            : undefined,
          authorizeDescription: matcher ? authorizationDescription(matcher) : undefined,
        }),
      });
    },
    buildAuthorizationMatcher: (ctx) =>
      buildAuthorizationMatcher(authorization, ctx),
  };
}

export const ReviewPolicies = {
  localMutation(options: HitlPresetOptions = {}): ToolkitToolReviewPolicy {
    return createPresetPolicy({
      ...options,
      requiresHitl: true,
      defaultAuthorization: 'none',
      defaultUnavailable: 'block',
    });
  },

  commandExecution(options: HitlPresetOptions = {}): ToolkitToolReviewPolicy {
    return createPresetPolicy({
      ...options,
      requiresHitl: true,
      defaultAuthorization: 'none',
      defaultUnavailable: 'block',
    });
  },

  externalAccess(options: HitlPresetOptions = {}): ToolkitToolReviewPolicy {
    return createPresetPolicy({
      ...options,
      requiresHitl: true,
      defaultAuthorization: 'none',
      defaultUnavailable: 'block',
    });
  },

  requireHitl(options: HitlPresetOptions = {}): ToolkitToolReviewPolicy {
    return createPresetPolicy({
      ...options,
      requiresHitl: true,
      defaultAuthorization: 'none',
      defaultUnavailable: 'block',
    });
  },

  never(): ToolkitToolReviewPolicy {
    return createPresetPolicy({
      requiresHitl: false,
      defaultAuthorization: 'none',
      defaultUnavailable: 'allow',
    });
  },

  custom(policy: ToolkitToolReviewPolicy): ToolkitToolReviewPolicy {
    return policy;
  },
};

export const reviewPolicies = ReviewPolicies;
