import type {
  ToolAuthorizationContext,
  ToolAuthorizationPolicy,
  ToolAutoAuthorizationContext,
  ToolOperationSummary,
  ToolReviewBlock,
  ToolReviewContext,
  ToolReviewPolicy,
} from '../../../types/toolkit';
import {
  exactAuthorization,
  markAuthorizationPolicyGeneration,
  urlOriginAuthorization,
  type ToolAuthorizationMatcher,
} from './authorizationMatchers';
import {
  buildReviewSpec,
  type ReviewOption,
  type ReviewView,
} from './reviewSpec';

export type ReviewUnavailableBehavior = 'block' | 'allow';
export type AuthorizationMode = 'exact' | 'url_origin';

export type ExactAuthorizationSubjectBuilder = (
  ctx: ToolAuthorizationContext,
) => unknown | null | Promise<unknown | null>;

export type ExactAuthorizationPolicyOptions = {
  subject?: ExactAuthorizationSubjectBuilder;
};

export type HitlPresetOptions = {
  authorization?: AuthorizationMode | ToolAuthorizationPolicy;
  autoAuthorize?: (ctx: ToolAutoAuthorizationContext) => boolean | Promise<boolean>;
  unavailable?: ReviewUnavailableBehavior;
};

type PresetOptions = HitlPresetOptions & {
  requiresHitl: boolean;
  defaultUnavailable: ReviewUnavailableBehavior;
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

function readOperationSummary(ctx: ToolReviewContext): ToolOperationSummary | null {
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

function buildReviewBody(ctx: ToolReviewContext, summary: ToolOperationSummary | null) {
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
  ctx: ToolReviewContext,
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

function buildReviewTitle(ctx: ToolReviewContext) {
  return ctx.operation?.title ?? ctx.toolName;
}

export function buildStandardReviewOptions(params: {
  authorize?: boolean;
  authorizeDescription?: string;
} = {}): ReviewOption[] {
  return [
    {
      id: 'approve',
      label: 'Approve',
      variant: 'primary',
      decision: { type: 'approve' },
    },
    ...(params.authorize ? [{
      id: 'approve-and-authorize-thread',
      label: 'Approve and authorize',
      description: params.authorizeDescription
        ?? 'Approve this action and authorize exact matching arguments in this thread.',
      decision: { type: 'approve' as const },
      effects: [{
        type: 'graph.authorize_tool_action' as const,
        scope: 'thread' as const,
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

function authorizationDescription(matcher: ToolAuthorizationMatcher) {
  if (matcher.type === 'url_origin') {
    return 'Approve this action and authorize the same URL domain in this thread.';
  }
  return 'Approve this action and authorize exact matching arguments in this thread.';
}

export const AuthorizationPolicies = {
  exact(options: ExactAuthorizationPolicyOptions = {}): ToolAuthorizationPolicy {
    const policy: ToolAuthorizationPolicy = {
      buildMatcher: async (ctx) => {
        const subject = options.subject
          ? await options.subject(ctx)
          : ctx.input;
        return subject === null ? null : exactAuthorization(subject);
      },
    };
    return markAuthorizationPolicyGeneration(
      policy,
      options.subject
        ? `exact:v1:projector:${Function.prototype.toString.call(options.subject)}`
        : 'exact:v1:full-input',
    );
  },

  urlOrigin(): ToolAuthorizationPolicy {
    const policy: ToolAuthorizationPolicy = {
      buildMatcher: (ctx) => {
        const input = inputToRecord(ctx.input);
        return urlOriginAuthorization(input.url);
      },
    };
    return markAuthorizationPolicyGeneration(policy, 'url_origin:v1');
  },
};

function resolveAuthorizationPolicy(
  authorization: HitlPresetOptions['authorization'],
): ToolAuthorizationPolicy | undefined {
  if (authorization === 'exact') {
    return AuthorizationPolicies.exact();
  }
  if (authorization === 'url_origin') {
    return AuthorizationPolicies.urlOrigin();
  }
  return authorization;
}

function blockReview(ctx: ToolReviewContext): ToolReviewBlock {
  return {
    type: 'block',
    reason: `Human review is required before running ${ctx.toolName}, but this runtime does not support HITL.`,
  };
}

function createPresetPolicy(options: PresetOptions): ToolReviewPolicy {
  const authorization = resolveAuthorizationPolicy(options.authorization);
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

      if (!capabilities.humanReview) {
        return unavailable === 'block'
          ? blockReview(ctx)
          : null;
      }

      const summary = readOperationSummary(ctx);
      return buildReviewSpec({
        view: buildReviewView(ctx, summary),
        options: buildStandardReviewOptions({
          authorize: Boolean(ctx.authorizationMatcher && capabilities.sessionAuthorization),
          authorizeDescription: ctx.authorizationMatcher
            ? authorizationDescription(ctx.authorizationMatcher)
            : undefined,
        }),
      });
    },
    ...(authorization ? { authorization } : {}),
    ...(options.autoAuthorize ? { autoAuthorize: options.autoAuthorize } : {}),
  };
}

export const ReviewPolicies = {
  localMutation(options: HitlPresetOptions = {}): ToolReviewPolicy {
    return createPresetPolicy({
      ...options,
      requiresHitl: true,
      defaultUnavailable: 'block',
    });
  },

  commandExecution(options: HitlPresetOptions = {}): ToolReviewPolicy {
    return createPresetPolicy({
      ...options,
      requiresHitl: true,
      defaultUnavailable: 'block',
    });
  },

  externalAccess(options: HitlPresetOptions = {}): ToolReviewPolicy {
    return createPresetPolicy({
      ...options,
      requiresHitl: true,
      defaultUnavailable: 'block',
    });
  },

  requireHitl(options: HitlPresetOptions = {}): ToolReviewPolicy {
    return createPresetPolicy({
      ...options,
      requiresHitl: true,
      defaultUnavailable: 'block',
    });
  },

  never(): ToolReviewPolicy {
    return createPresetPolicy({
      requiresHitl: false,
      defaultUnavailable: 'allow',
    });
  },

  custom(policy: ToolReviewPolicy): ToolReviewPolicy {
    return policy;
  },
};

export const reviewPolicies = ReviewPolicies;
