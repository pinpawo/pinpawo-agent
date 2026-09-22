import { type BaseMessage } from '@langchain/core/messages';
import {
  DEFAULT_TOOL_AUTHORIZATION_SAFETY_LEVEL,
  type ToolAuthorizationMode,
  type ToolAuthorizationSafetyLevel,
} from '@pinpawo/agent-contracts';
import type { AgentModels } from '../../../types/agent';
import { createAutoReviewer } from '../../../autoReview/autoReviewer';
import type { AutoReviewAction, AutoReviewStructuredOutputConfig } from '../../../autoReview/types';

export const GLOBAL_REVIEW_POLICY_MODE = {
  REQUIRE_AUTHORIZATION: 'require_authorization',
  AUTO_AUTHORIZATION: 'auto_authorization',
  FULL_ACCESS: 'full_access',
  CUSTOM: 'custom',
} as const;

export const GLOBAL_REVIEW_POLICY_RESOLUTION = {
  REQUIRE_AUTHORIZATION: 'require_authorization',
  AUTHORIZE: 'authorize',
} as const;

export const GLOBAL_REVIEW_POLICY_RUNTIME_EVENT = {
  AUTO_AUTHORIZED: 'global_review_policy_auto_authorized',
  CUSTOM_AUTHORIZED: 'global_review_policy_custom_authorized',
} as const;

/** @deprecated Use ToolAuthorizationMode from @pinpawo/agent-contracts. */
export type BuiltinGlobalReviewPolicyMode = ToolAuthorizationMode;
export type GlobalReviewPolicyMode = BuiltinGlobalReviewPolicyMode | typeof GLOBAL_REVIEW_POLICY_MODE.CUSTOM;

export type GlobalReviewPolicyStructuredOutputConfig = AutoReviewStructuredOutputConfig;

export type GlobalReviewPolicyResolution =
  | { type: typeof GLOBAL_REVIEW_POLICY_RESOLUTION.REQUIRE_AUTHORIZATION; reason?: string }
  | { type: typeof GLOBAL_REVIEW_POLICY_RESOLUTION.AUTHORIZE; reason: string };

type GlobalReviewRuntimeContext = {
  /** Non-authoritative relevance hint; it may only make auto review more conservative. */
  task?: string | null;
};

export type GlobalReviewPolicyContext = GlobalReviewRuntimeContext & AutoReviewAction & {
  models: AgentModels;
  /** Custom policy context only; built-in auto authorization never forwards messages to its model. */
  messages: BaseMessage[];
};

export type GlobalReviewPolicyResolver = (
  ctx: GlobalReviewPolicyContext
) => GlobalReviewPolicyResolution | Promise<GlobalReviewPolicyResolution>;

export type GlobalReviewPolicyBatchItem = AutoReviewAction;

export type GlobalReviewPolicyBatchContext = GlobalReviewRuntimeContext & {
  models: AgentModels;
  /** Custom policy context only; built-in auto authorization never forwards messages to its model. */
  messages: BaseMessage[];
  reviews: GlobalReviewPolicyBatchItem[];
};

export type GlobalReviewPolicyBatchResolver = (
  ctx: GlobalReviewPolicyBatchContext
) => GlobalReviewPolicyResolution | Promise<GlobalReviewPolicyResolution>;

export type GlobalReviewPolicy =
  | {
      mode: BuiltinGlobalReviewPolicyMode;
      /** Controls the automatic-review threshold; ignored by non-auto modes. */
      safetyLevel?: ToolAuthorizationSafetyLevel;
      structuredOutput?: GlobalReviewPolicyStructuredOutputConfig;
    }
  | {
      mode: typeof GLOBAL_REVIEW_POLICY_MODE.CUSTOM;
      resolve: GlobalReviewPolicyResolver;
      resolveBatch?: GlobalReviewPolicyBatchResolver;
      /** Opt in to reusing grants originally established by auto review. */
      reuseAutoAuthorizations?: boolean;
    };

export type ResolveGlobalReviewPolicyOptions = GlobalReviewPolicyContext & {
  policy?: GlobalReviewPolicy;
};

export type ResolveGlobalReviewBatchPolicyOptions = GlobalReviewPolicyBatchContext & {
  policy?: GlobalReviewPolicy;
};

const DEFAULT_AUTO_REVIEW_REASON = 'Auto authorization did not approve this tool-call batch.';
const STRICT_AUTO_REVIEW_MAX_RISK_SCORE = 2;
const RELAXED_AUTO_REVIEW_MAX_RISK_SCORE = 9;

function normalizeReason(reason: string | undefined, fallback: string) {
  const trimmed = reason?.trim();
  if (!trimmed) return fallback;
  return trimmed.length <= 500
    ? trimmed
    : `${trimmed.slice(0, 500)}\n[truncated ${trimmed.length - 500} chars]`;
}

async function resolveAutoAuthorization(
  options: Pick<
    ResolveGlobalReviewBatchPolicyOptions,
    'models' | 'policy' | 'reviews' | 'task'
  >,
): Promise<GlobalReviewPolicyResolution> {
  const model = options.models.decision ?? options.models.observe ?? options.models.act;
  try {
    const structuredOutput = options.policy?.mode === GLOBAL_REVIEW_POLICY_MODE.AUTO_AUTHORIZATION
      ? options.policy.structuredOutput
      : undefined;
    const safetyLevel = options.policy?.mode === GLOBAL_REVIEW_POLICY_MODE.AUTO_AUTHORIZATION
      ? options.policy.safetyLevel ?? DEFAULT_TOOL_AUTHORIZATION_SAFETY_LEVEL
      : DEFAULT_TOOL_AUTHORIZATION_SAFETY_LEVEL;
    const result = await createAutoReviewer({ model, structuredOutput }).assess({
      reviews: options.reviews,
      task: options.task,
    });
    if (!result.complete) {
      return {
        type: GLOBAL_REVIEW_POLICY_RESOLUTION.REQUIRE_AUTHORIZATION,
        reason: 'Auto review context exceeds the safe evidence budget; human authorization is required.',
      };
    }
    const { assessment } = result;

    const maxRiskScore = safetyLevel === 'relaxed'
      ? RELAXED_AUTO_REVIEW_MAX_RISK_SCORE
      : STRICT_AUTO_REVIEW_MAX_RISK_SCORE;
    if (assessment.riskScore <= maxRiskScore) {
      return {
        type: GLOBAL_REVIEW_POLICY_RESOLUTION.AUTHORIZE,
        reason: normalizeReason(
          assessment.reason,
          `Auto authorization approved this tool-call batch at risk score ${assessment.riskScore}.`,
        ),
      };
    }
    return {
      type: GLOBAL_REVIEW_POLICY_RESOLUTION.REQUIRE_AUTHORIZATION,
      reason: normalizeReason(assessment.reason, DEFAULT_AUTO_REVIEW_REASON),
    };
  } catch (error) {
    console.warn('[pet-agent] auto global review authorization failed:', {
      error: error instanceof Error ? error.message : String(error),
    });
    return {
      type: GLOBAL_REVIEW_POLICY_RESOLUTION.REQUIRE_AUTHORIZATION,
      reason: 'Auto authorization failed; falling back to human authorization.',
    };
  }
}

export async function resolveGlobalReviewBatchPolicy(
  options: ResolveGlobalReviewBatchPolicyOptions,
): Promise<GlobalReviewPolicyResolution> {
  if (options.reviews.length === 0) {
    return { type: GLOBAL_REVIEW_POLICY_RESOLUTION.AUTHORIZE, reason: 'No reviewed tool calls in this batch.' };
  }
  const mode = options.policy?.mode ?? GLOBAL_REVIEW_POLICY_MODE.REQUIRE_AUTHORIZATION;
  if (mode === GLOBAL_REVIEW_POLICY_MODE.FULL_ACCESS) {
    return { type: GLOBAL_REVIEW_POLICY_RESOLUTION.AUTHORIZE, reason: 'Full access is enabled.' };
  }
  if (mode === GLOBAL_REVIEW_POLICY_MODE.AUTO_AUTHORIZATION) {
    return resolveAutoAuthorization(options);
  }
  if (mode === GLOBAL_REVIEW_POLICY_MODE.REQUIRE_AUTHORIZATION) {
    return { type: GLOBAL_REVIEW_POLICY_RESOLUTION.REQUIRE_AUTHORIZATION };
  }
  if (options.policy?.mode === GLOBAL_REVIEW_POLICY_MODE.CUSTOM) {
    try {
      if (options.policy.resolveBatch) {
        const { policy: _policy, ...ctx } = options;
        return await options.policy.resolveBatch(ctx);
      }
      for (const review of options.reviews) {
        const resolution = await options.policy.resolve({
          models: options.models,
          messages: options.messages,
          task: options.task,
          ...review,
        });
        if (resolution.type !== GLOBAL_REVIEW_POLICY_RESOLUTION.AUTHORIZE) {
          return resolution;
        }
      }
      return {
        type: GLOBAL_REVIEW_POLICY_RESOLUTION.AUTHORIZE,
        reason: 'Custom policy authorized every reviewed tool call in the batch.',
      };
    } catch (error) {
      console.warn('[pet-agent] custom global review policy failed:', {
        error: error instanceof Error ? error.message : String(error),
      });
      return {
        type: GLOBAL_REVIEW_POLICY_RESOLUTION.REQUIRE_AUTHORIZATION,
        reason: 'Custom global review policy failed; falling back to human authorization.',
      };
    }
  }
  return { type: GLOBAL_REVIEW_POLICY_RESOLUTION.REQUIRE_AUTHORIZATION };
}

export async function resolveGlobalReviewPolicy(
  options: ResolveGlobalReviewPolicyOptions,
): Promise<GlobalReviewPolicyResolution> {
  const {
    policy,
    models,
    messages,
    task,
    ...review
  } = options;
  return resolveGlobalReviewBatchPolicy({
    policy,
    models,
    messages,
    task,
    reviews: [review],
  });
}
