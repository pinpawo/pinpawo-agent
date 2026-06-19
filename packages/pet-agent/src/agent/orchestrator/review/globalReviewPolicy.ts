import { HumanMessage, SystemMessage, type BaseMessage } from '@langchain/core/messages';
import { z } from 'zod';
import type { AgentActor, AgentModels } from '../../../types/agent';
import type { StructuredOutputOptions } from '../../../utils/structuredOutput';
import { invokeStructuredOutput } from '../../../utils/structuredOutput';
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
  | { type: typeof GLOBAL_REVIEW_POLICY_RESOLUTION.AUTHORIZE; reason: string; confidence?: 'low' | 'medium' | 'high' };

type ToolReviewOperationSummary = {
  target?: string;
  summary?: string;
  details?: Record<string, unknown>;
};

type ToolReviewOperationMetadata = {
  title?: string;
  summarizeInput?: (input: unknown) => ToolReviewOperationSummary | null;
};

export type GlobalReviewPolicyContext = {
  models: AgentModels;
  actor: AgentActor;
  messages: BaseMessage[];
  toolkitName: string;
  toolName: string;
  input: unknown;
  operation?: ToolReviewOperationMetadata;
  review: ReviewSpec;
};

export type GlobalReviewPolicyResolver = (
  ctx: GlobalReviewPolicyContext
) => GlobalReviewPolicyResolution | Promise<GlobalReviewPolicyResolution>;

export type GlobalReviewPolicy =
  | {
      mode: BuiltinGlobalReviewPolicyMode;
      structuredOutput?: GlobalReviewPolicyStructuredOutputConfig;
    }
  | {
      mode: typeof GLOBAL_REVIEW_POLICY_MODE.CUSTOM;
      resolve: GlobalReviewPolicyResolver;
    };

export type ResolveGlobalReviewPolicyOptions = GlobalReviewPolicyContext & {
  policy?: GlobalReviewPolicy;
};

const AUTO_REVIEW_DECISION_SCHEMA = z.object({
  decision: z.enum([
    GLOBAL_REVIEW_POLICY_RESOLUTION.AUTHORIZE,
    GLOBAL_REVIEW_POLICY_RESOLUTION.REQUIRE_AUTHORIZATION,
  ]),
  reason: z.string().optional().default(''),
  confidence: z.enum(['low', 'medium', 'high']).optional(),
});

const AUTO_REVIEW_SYSTEM_PROMPT = [
  'You are a conservative security gate.',
  'You only decide whether a proposed tool call may be automatically authorized.',
  'When uncertain, require human authorization.',
  'Return the decision as a JSON object matching the structured output schema.',
].join(' ');

const DEFAULT_AUTO_REVIEW_REASON = 'Auto authorization did not approve this tool call.';
const MAX_PROMPT_CHARS = 8_000;
const MAX_FIELD_CHARS = 2_000;
const MAX_RECENT_MESSAGES = 6;

function clipText(value: string, limit = MAX_FIELD_CHARS) {
  return value.length <= limit
    ? value
    : `${value.slice(0, limit)}\n[truncated ${value.length - limit} chars]`;
}

function safeJson(value: unknown, limit = MAX_FIELD_CHARS) {
  try {
    return clipText(JSON.stringify(value, null, 2), limit);
  } catch {
    return clipText(String(value), limit);
  }
}

function readMessageText(message: BaseMessage) {
  const content = message.content;
  if (typeof content === 'string') {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === 'string') return part;
        if (part && typeof part === 'object' && 'text' in part && typeof part.text === 'string') {
          return part.text;
        }
        return '';
      })
      .join('');
  }
  return '';
}

function formatRecentMessages(messages: BaseMessage[]) {
  const recent = messages.slice(-MAX_RECENT_MESSAGES)
    .map((message) => {
      const text = readMessageText(message).trim();
      if (!text) return null;
      return `${message._getType()}: ${clipText(text, 800)}`;
    })
    .filter((line): line is string => Boolean(line));
  return recent.length > 0 ? recent.join('\n\n') : '(no recent conversation)';
}

function readOperationSummary(operation: ToolReviewOperationMetadata | undefined, input: unknown) {
  try {
    return operation?.summarizeInput?.(input) ?? null;
  } catch {
    return null;
  }
}

function buildAutoReviewPrompt(options: ResolveGlobalReviewPolicyOptions) {
  const summary = readOperationSummary(options.operation, options.input);
  const lines = [
    'Review this local agent tool call and decide whether it may run without human review.',
    '',
    'Return "authorize" only when the action is low risk, clearly expected from the user request, scoped, and unlikely to destroy data, leak secrets, spend money, change credentials, install software, or perform irreversible external side effects.',
    'Return "require_authorization" for destructive writes, broad file changes, shell commands with unclear effects, network actions involving credentials or exfiltration, permission changes, package installs, git publish/commit actions, or whenever you are uncertain.',
    '',
    `Actor: ${options.actor.name}`,
    `Toolkit: ${options.toolkitName}`,
    `Tool: ${options.toolName}`,
    options.operation?.title ? `Operation title: ${options.operation.title}` : null,
    summary?.summary ? `Operation summary: ${summary.summary}` : null,
    summary?.target ? `Operation target: ${summary.target}` : null,
    summary?.details ? `Operation details:\n${safeJson(summary.details)}` : null,
    '',
    `Review title: ${options.review.view.title ?? options.toolName}`,
    `Review body:\n${clipText(options.review.view.body, MAX_FIELD_CHARS)}`,
    '',
    `Tool input:\n${safeJson(options.input)}`,
    '',
    `Recent conversation:\n${formatRecentMessages(options.messages)}`,
  ].filter((line): line is string => line !== null);

  return clipText(lines.join('\n'), MAX_PROMPT_CHARS);
}

function normalizeReason(reason: string | undefined, fallback: string) {
  const trimmed = reason?.trim();
  return trimmed ? clipText(trimmed, 500) : fallback;
}

async function resolveAutoAuthorization(
  options: ResolveGlobalReviewPolicyOptions,
): Promise<GlobalReviewPolicyResolution> {
  const model = options.models.observe ?? options.models.act;

  try {
    const decision = await invokeStructuredOutput({
      model,
      schema: AUTO_REVIEW_DECISION_SCHEMA,
      options: {
        name: 'global_review_policy_auto_decision',
        ...(options.policy?.mode === GLOBAL_REVIEW_POLICY_MODE.AUTO_AUTHORIZATION
          ? options.policy.structuredOutput
          : undefined),
      },
      messages: [
        new SystemMessage(AUTO_REVIEW_SYSTEM_PROMPT),
        new HumanMessage(buildAutoReviewPrompt(options)),
      ],
    });

    if (decision.decision === GLOBAL_REVIEW_POLICY_RESOLUTION.AUTHORIZE) {
      return {
        type: GLOBAL_REVIEW_POLICY_RESOLUTION.AUTHORIZE,
        reason: normalizeReason(decision.reason, 'Auto authorization approved this tool call.'),
        ...(decision.confidence ? { confidence: decision.confidence } : {}),
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

export async function resolveGlobalReviewPolicy(
  options: ResolveGlobalReviewPolicyOptions,
): Promise<GlobalReviewPolicyResolution> {
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
      const { policy: _policy, ...ctx } = options;
      return await options.policy.resolve(ctx);
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
