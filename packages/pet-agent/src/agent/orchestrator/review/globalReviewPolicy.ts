import { HumanMessage, SystemMessage, type BaseMessage } from '@langchain/core/messages';
import { z } from 'zod';
import type { AgentActor, AgentModels } from '../../../types/agent';
import type { StructuredOutputOptions } from '../../../utils/structuredOutput';
import { invokeStructuredOutput } from '../../../utils/structuredOutput';
import {
  buildAutoReviewPrompt,
  buildAutoReviewSystemPrompt,
} from '../prompts/autoReview';
import type { ReviewSpec } from './reviewSpec';

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

export type BuiltinGlobalReviewPolicyMode =
  | typeof GLOBAL_REVIEW_POLICY_MODE.REQUIRE_AUTHORIZATION
  | typeof GLOBAL_REVIEW_POLICY_MODE.AUTO_AUTHORIZATION
  | typeof GLOBAL_REVIEW_POLICY_MODE.FULL_ACCESS;
export type GlobalReviewPolicyMode = BuiltinGlobalReviewPolicyMode | typeof GLOBAL_REVIEW_POLICY_MODE.CUSTOM;

export type GlobalReviewPolicyStructuredOutputConfig = Omit<StructuredOutputOptions, 'name'>;

export type GlobalReviewPolicyResolution =
  | { type: typeof GLOBAL_REVIEW_POLICY_RESOLUTION.REQUIRE_AUTHORIZATION; reason?: string }
  | { type: typeof GLOBAL_REVIEW_POLICY_RESOLUTION.AUTHORIZE; reason: string };

type ToolReviewOperationMetadata = {
  title?: string;
  summarizeInput?: (input: unknown) => ToolReviewOperationSummary | null;
};

type ToolReviewOperationSummary = {
  target?: string;
  summary?: string;
  details?: Record<string, unknown>;
};

type GlobalReviewRuntimeContext = {
  /** Non-authoritative relevance hint; it may only make auto review more conservative. */
  task?: string | null;
  /** Effective workdir used to interpret relative paths and mutation scope. */
  workdir?: string | null;
};

type ToolkitAutoReviewContext = {
  allow: string;
  ask: string;
};

export type GlobalReviewPolicyContext = GlobalReviewRuntimeContext & {
  models: AgentModels;
  actor: AgentActor;
  /** Custom policy context only; built-in auto authorization never forwards messages to its model. */
  messages: BaseMessage[];
  toolkitName: string;
  toolName: string;
  input: unknown;
  operation?: ToolReviewOperationMetadata;
  autoReviewContext?: ToolkitAutoReviewContext;
  review: ReviewSpec;
};

export type GlobalReviewPolicyResolver = (
  ctx: GlobalReviewPolicyContext
) => GlobalReviewPolicyResolution | Promise<GlobalReviewPolicyResolution>;

export type GlobalReviewPolicyBatchItem = Omit<
  GlobalReviewPolicyContext,
  'models' | 'actor' | 'messages' | keyof GlobalReviewRuntimeContext
>;

export type GlobalReviewPolicyBatchContext = GlobalReviewRuntimeContext & {
  models: AgentModels;
  actor: AgentActor;
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
      structuredOutput?: GlobalReviewPolicyStructuredOutputConfig;
    }
  | {
      mode: typeof GLOBAL_REVIEW_POLICY_MODE.CUSTOM;
      resolve: GlobalReviewPolicyResolver;
      resolveBatch?: GlobalReviewPolicyBatchResolver;
    };

export type ResolveGlobalReviewPolicyOptions = GlobalReviewPolicyContext & {
  policy?: GlobalReviewPolicy;
};

export type ResolveGlobalReviewBatchPolicyOptions = GlobalReviewPolicyBatchContext & {
  policy?: GlobalReviewPolicy;
};

const AUTO_REVIEW_DECISION_SCHEMA = z.object({
  decision: z.enum([
    GLOBAL_REVIEW_POLICY_RESOLUTION.AUTHORIZE,
    GLOBAL_REVIEW_POLICY_RESOLUTION.REQUIRE_AUTHORIZATION,
  ]).describe('Whether the complete batch may run automatically or requires human authorization.'),
  reason: z.string().optional().default('').describe(
    'A concise explanation grounded in the concrete action facts and authorization policy.',
  ),
});

const DEFAULT_AUTO_REVIEW_REASON = 'Auto authorization did not approve this tool-call batch.';

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
    'models' | 'policy' | 'reviews' | 'task' | 'workdir'
  >,
): Promise<GlobalReviewPolicyResolution> {
  const model = options.models.decision ?? options.models.observe ?? options.models.act;
  const prompt = buildAutoReviewPrompt({
    task: options.task,
    workdir: options.workdir,
    reviews: options.reviews,
  });
  if (!prompt.complete) {
    return {
      type: GLOBAL_REVIEW_POLICY_RESOLUTION.REQUIRE_AUTHORIZATION,
      reason: 'Auto review context exceeds the safe evidence budget; human authorization is required.',
    };
  }

  try {
    const structuredOutput = options.policy?.mode === GLOBAL_REVIEW_POLICY_MODE.AUTO_AUTHORIZATION
      ? options.policy.structuredOutput
      : undefined;
    const decision = await invokeStructuredOutput({
      model,
      schema: AUTO_REVIEW_DECISION_SCHEMA,
      options: {
        name: 'global_review_policy_auto_decision',
        autoRepair: true,
        ...structuredOutput,
      },
      messages: [
        new SystemMessage(buildAutoReviewSystemPrompt(options.reviews, structuredOutput?.method)),
        new HumanMessage(prompt.text),
      ],
    });

    if (decision.decision === GLOBAL_REVIEW_POLICY_RESOLUTION.AUTHORIZE) {
      return {
        type: GLOBAL_REVIEW_POLICY_RESOLUTION.AUTHORIZE,
        reason: normalizeReason(decision.reason, 'Auto authorization approved this tool-call batch.'),
      };
    }
    return {
      type: GLOBAL_REVIEW_POLICY_RESOLUTION.REQUIRE_AUTHORIZATION,
      reason: normalizeReason(decision.reason, DEFAULT_AUTO_REVIEW_REASON),
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
          actor: options.actor,
          messages: options.messages,
          task: options.task,
          workdir: options.workdir,
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
    actor,
    messages,
    task,
    workdir,
    ...review
  } = options;
  return resolveGlobalReviewBatchPolicy({
    policy,
    models,
    actor,
    messages,
    task,
    workdir,
    reviews: [review],
  });
}
