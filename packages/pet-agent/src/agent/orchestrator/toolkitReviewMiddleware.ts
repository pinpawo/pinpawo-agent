import { createHash } from 'node:crypto';
import { AIMessage, RemoveMessage, ToolMessage, type BaseMessage, type ToolCall } from '@langchain/core/messages';
import { REMOVE_ALL_MESSAGES, getConfig } from '@langchain/langgraph';
import { createMiddleware, type AnyAgentMiddleware } from 'langchain';
import { z } from 'zod';
import type {
  AgentToolkit,
  ModelInputModality,
  ToolkitReviewCapabilities,
  ToolReviewPolicy,
  ToolOperationMetadata,
} from '../../types/toolkit';
import type { AgentActor, AgentModels } from '../../types/agent';
import type { SubagentRuntimeEvent } from '../../types/subagent';
import {
  buildToolAuthorizationRecord,
  findToolAuthorization,
  mergeToolAuthorizations,
  readToolAuthorizationMatcher,
  ReviewEffectApplicationError,
  toolAuthorizationRecordKey,
  type ToolAuthorizationRecord,
} from './review/reviewAuthorizations';
import type { ToolAuthorizationMatcher } from './review/authorizationMatchers';
import {
  reviewViewToText,
} from './review/reviewSpec';
import type {
  PendingReviewAction,
  ReviewSpec,
  HumanReviewInterruptPayload,
} from './review/reviewSpec';
import {
  GLOBAL_REVIEW_POLICY_MODE,
  GLOBAL_REVIEW_POLICY_RESOLUTION,
  GLOBAL_REVIEW_POLICY_RUNTIME_EVENT,
  resolveGlobalReviewBatchPolicy,
  type GlobalReviewPolicy,
  type GlobalReviewPolicyBatchItem,
  type GlobalReviewPolicyResolution,
} from './review/globalReviewPolicy';
import {
  PauseTaskInterruptStateSchema,
  ReviewInterrupt,
  type ReviewInterruptTransition,
  type ReviewInterruptReview,
} from './interrupt';

export type ToolkitReviewRuntimeContext = {
  models: AgentModels;
  /** Input modalities the active model profile accepts. */
  modelInputModalities?: readonly ModelInputModality[];
  actor?: AgentActor;
  messages: BaseMessage[];
  reviewContext?: {
    task?: string | null;
    workdir?: string | null;
  };
  reviewCapabilities?: ToolkitReviewCapabilities;
  globalReviewPolicy?: GlobalReviewPolicy;
  toolAuthorizations?: ToolAuthorizationRecord[];
  recordToolAuthorizations?: (
    authorizations: ToolAuthorizationRecord[],
  ) => void | Promise<void>;
  emitRuntimeEvent?: (event: SubagentRuntimeEvent) => void | Promise<void>;
};

function buildCancelledToolResult(params: {
  toolName: string;
  toolkitName: string;
  reason: string;
  input: unknown;
  source: ToolkitReviewCancellationSource;
}) {
  const guidance = params.source === 'review_unavailable'
    ? 'This action requires human authorization that is unavailable in this runtime. Do not retry it; choose an allowed alternative or explain the constraint.'
    : 'This action is blocked by policy. Do not retry it; choose an allowed alternative or explain the constraint.';
  return JSON.stringify({
    ok: false,
    cancelled: true,
    source: params.source,
    toolName: params.toolName,
    toolkitName: params.toolkitName,
    reason: params.reason,
    input: params.input,
    retryable: false,
    guidance,
  });
}

function reviewCapabilitiesForGlobalPolicy(ctx: ToolkitReviewRuntimeContext) {
  const mode = ctx.globalReviewPolicy?.mode ?? GLOBAL_REVIEW_POLICY_MODE.REQUIRE_AUTHORIZATION;
  if (
    mode !== GLOBAL_REVIEW_POLICY_MODE.AUTO_AUTHORIZATION
    && mode !== GLOBAL_REVIEW_POLICY_MODE.CUSTOM
  ) {
    return ctx.reviewCapabilities;
  }
  const current = ctx.reviewCapabilities ?? {
    humanReview: false,
    sessionAuthorization: false,
  };
  return {
    ...current,
    humanReview: true,
  };
}

function runtimeCanCollectHumanReview(ctx: ToolkitReviewRuntimeContext) {
  return ctx.reviewCapabilities?.humanReview !== false;
}

/**
 * Temporary compatibility tracked by pinpawo-agent#749 for
 * langchain-ai/langgraphjs#2667. A completed
 * task() is currently re-executed when an interrupted nested graph resumes, so
 * detect the pending value for this exact interrupt slot and skip repeating the
 * global Review policy. Remove this when the upstream fix is released.
 */
function hasPendingReviewInterruptResume() {
  try {
    const configurable = getConfig().configurable as Record<string, unknown> | undefined;
    const scratchpad = configurable?.__pregel_scratchpad;
    if (!scratchpad || typeof scratchpad !== 'object') {
      return false;
    }
    const record = scratchpad as {
      interruptCounter?: unknown;
      nullResume?: unknown;
      resume?: unknown;
    };
    const interruptCounter = typeof record.interruptCounter === 'number'
      ? record.interruptCounter
      : -1;
    const nextInterruptIndex = interruptCounter + 1;
    return (
      Array.isArray(record.resume)
      && nextInterruptIndex < record.resume.length
    ) || record.nullResume !== undefined;
  } catch {
    return false;
  }
}

function toolAuthorizationsForGlobalPolicy(ctx: ToolkitReviewRuntimeContext) {
  if (
    ctx.globalReviewPolicy?.mode === GLOBAL_REVIEW_POLICY_MODE.AUTO_AUTHORIZATION
    || (
      ctx.globalReviewPolicy?.mode === GLOBAL_REVIEW_POLICY_MODE.CUSTOM
      && ctx.globalReviewPolicy.reuseAutoAuthorizations === true
    )
  ) {
    return ctx.toolAuthorizations;
  }
  return ctx.toolAuthorizations?.filter((authorization) =>
    authorization.source !== 'auto_review');
}

function buildHumanReviewUnavailableReason(resolution: GlobalReviewPolicyResolution | null) {
  if (
    resolution?.type === GLOBAL_REVIEW_POLICY_RESOLUTION.REQUIRE_AUTHORIZATION
    && resolution.reason
  ) {
    return `${resolution.reason} Human review is unavailable in this runtime.`;
  }
  return 'Human review is required for this tool call, but this runtime cannot collect a human decision.';
}

function globalReviewPolicyAuthorizedEventName(mode: string | undefined) {
  if (mode === GLOBAL_REVIEW_POLICY_MODE.AUTO_AUTHORIZATION) {
    return GLOBAL_REVIEW_POLICY_RUNTIME_EVENT.AUTO_AUTHORIZED;
  }
  if (mode === GLOBAL_REVIEW_POLICY_MODE.CUSTOM) {
    return GLOBAL_REVIEW_POLICY_RUNTIME_EVENT.CUSTOM_AUTHORIZED;
  }
  return null;
}

function isToolkitReviewBlock(value: unknown): value is { type: 'block'; reason: string } {
  return Boolean(
    value
    && typeof value === 'object'
    && (value as { type?: unknown }).type === 'block'
    && typeof (value as { reason?: unknown }).reason === 'string',
  );
}

function stableStringify(value: unknown): string {
  if (!value || typeof value !== 'object') {
    return JSON.stringify(value) ?? String(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  }
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
    .join(',')}}`;
}

function stableToolCallHash(toolCall: ToolCall) {
  return createHash('sha256')
    .update(stableStringify({ name: toolCall.name, args: toolCall.args }))
    .digest('hex')
    .slice(0, 12);
}

function readToolCallId(toolCall: ToolCall) {
  const id = toolCall.id;
  return typeof id === 'string' && id.trim() ? id.trim() : 'pending_action';
}

function materializeToolCallId(toolCall: ToolCall, messageIndex: number, toolCallIndex: number): ToolCall {
  const explicitId = typeof toolCall.id === 'string' && toolCall.id.trim()
    ? toolCall.id.trim()
    : null;
  const actionId = explicitId
    ?? `pending_action:${messageIndex}:${toolCallIndex}:${stableToolCallHash(toolCall)}`;
  return toolCall.id === actionId ? toolCall : { ...toolCall, id: actionId };
}

function materializeToolCallIds(
  toolCalls: ToolCall[],
  messageIndex: number,
): ToolCall[] {
  return toolCalls.map((toolCall, index) => materializeToolCallId(toolCall, messageIndex, index));
}

function cloneAIMessageWithToolCalls(message: AIMessage, toolCalls: ToolCall[]): AIMessage {
  return new AIMessage({
    content: message.content,
    id: message.id,
    name: message.name,
    additional_kwargs: { ...message.additional_kwargs },
    response_metadata: { ...message.response_metadata },
    tool_calls: toolCalls,
    invalid_tool_calls: message.invalid_tool_calls,
    usage_metadata: message.usage_metadata,
  });
}

function replaceMessageInState(
  messages: BaseMessage[],
  index: number,
  replacement: BaseMessage,
  appended: BaseMessage[],
) {
  return [
    new RemoveMessage({ id: REMOVE_ALL_MESSAGES }) as BaseMessage,
    ...messages.slice(0, index),
    replacement,
    ...messages.slice(index + 1),
    ...appended,
  ];
}

function inputToActionArgs(input: unknown): Record<string, unknown> {
  return input && typeof input === 'object' && !Array.isArray(input)
    ? { ...(input as Record<string, unknown>) }
    : { input };
}

function formatReviewPrompt(review: ReviewSpec) {
  return [
    review.view.title,
    reviewViewToText(review.view),
  ].filter((item): item is string => Boolean(item && item.trim())).join('\n');
}

function buildPendingReviewAction(params: {
  toolName: string;
  input: unknown;
  review: ReviewSpec;
  toolCall: ToolCall;
}): PendingReviewAction {
  const prompt = formatReviewPrompt(params.review);
  return {
    actionId: readToolCallId(params.toolCall),
    toolName: params.toolName,
    args: inputToActionArgs(params.input),
    ...(prompt ? { description: prompt.split('\n')[0] } : {}),
  };
}

function buildToolReviewId(action: PendingReviewAction) {
  return `tool-review:${action.toolName}:${action.actionId}`;
}

function buildToolReviewIdForToolCall(toolName: string, toolCall: ToolCall) {
  return `tool-review:${toolName}:${readToolCallId(toolCall)}`;
}

function materializeToolReviewSpec(review: ReviewSpec, action: PendingReviewAction): ReviewSpec {
  const id = buildToolReviewId(action);
  return review.id === id
    ? review
    : { ...review, id };
}

function buildHumanReviewInterruptPayload(params: {
  toolName: string;
  input: unknown;
  review: ReviewSpec;
  toolCall: ToolCall;
}): HumanReviewInterruptPayload {
  const pendingAction = buildPendingReviewAction(params);
  return {
    kind: 'review',
    review: materializeToolReviewSpec(params.review, pendingAction),
    pendingAction,
  };
}

async function recordToolAuthorizations(
  ctx: ToolkitReviewRuntimeContext,
  authorizations: ToolAuthorizationRecord[],
) {
  if (authorizations.length === 0) {
    return;
  }
  if (!ctx.recordToolAuthorizations) {
    throw new ReviewEffectApplicationError(
      'missing_thread',
      'Cannot apply authorization effects without an orchestrator authorization recorder.',
    );
  }
  const existingByKey = new Map(
    mergeToolAuthorizations([], ctx.toolAuthorizations ?? []).map((authorization) => [
      toolAuthorizationRecordKey(authorization),
      authorization,
    ]),
  );
  const changes = mergeToolAuthorizations([], authorizations).filter((authorization) => {
    const existing = existingByKey.get(toolAuthorizationRecordKey(authorization));
    return !existing
      || (existing.source === 'auto_review' && authorization.source === 'human');
  });
  const upgrades = changes.filter((authorization) =>
    existingByKey.get(toolAuthorizationRecordKey(authorization))?.source === 'auto_review');
  await ctx.recordToolAuthorizations(authorizations);
  for (const authorization of changes) {
    await ctx.emitRuntimeEvent?.({
      event: 'on_runtime_event',
      name: 'tool_authorization_recorded',
      data: {
        toolName: authorization.toolName,
        matcherType: authorization.matcher.type,
        source: authorization.source,
        scope: 'thread',
      },
    });
  }
  for (const authorization of upgrades) {
    await ctx.emitRuntimeEvent?.({
      event: 'on_runtime_event',
      name: 'tool_authorization_upgraded',
      data: {
        toolName: authorization.toolName,
        matcherType: authorization.matcher.type,
        source: authorization.source,
        scope: 'thread',
      },
    });
  }
}

/**
 * Auto review owns only the concrete batch it inspected. Reuse that approval
 * for exact matching arguments in the same checkpointed session, but never
 * widen it to a shell wildcard, URL domain, or toolkit-defined broad matcher.
 */
async function buildAutoReviewSessionAuthorizations(params: {
  ctx: ToolkitReviewRuntimeContext;
  reviews: PreparedToolkitReview[];
}) {
  if (
    params.ctx.globalReviewPolicy?.mode !== GLOBAL_REVIEW_POLICY_MODE.AUTO_AUTHORIZATION
    || params.ctx.reviewCapabilities?.sessionAuthorization !== true
    || !params.ctx.recordToolAuthorizations
  ) {
    return [];
  }

  return params.reviews.flatMap((review) =>
    review.authorizationMatcher?.type === 'exact'
      ? [buildToolAuthorizationRecord({
          toolName: review.toolName,
          matcher: review.authorizationMatcher,
          source: 'auto_review',
        })]
      : []);
}

export type ToolkitReviewBinding = {
  toolkit: AgentToolkit;
  toolName: string;
  reviewPolicy: ToolReviewPolicy;
  operation?: ToolOperationMetadata;
};

type PreparedToolkitReview = GlobalReviewPolicyBatchItem & {
  toolCall: ToolCall;
  reviewPolicy: ToolReviewPolicy;
  reviewPayload: HumanReviewInterruptPayload;
  authorizationMatcher: ToolAuthorizationMatcher | null;
};

type ToolkitReviewPreparation =
  | { type: 'allow' }
  | { type: 'review'; review: PreparedToolkitReview }
  | {
      type: 'cancel';
      toolCall: ToolCall;
      content: string;
      reason: string;
      source: ToolkitReviewCancellationSource;
    };

type ToolkitReviewCancellation = Extract<ToolkitReviewPreparation, { type: 'cancel' }>;

type ToolkitReviewCancellationSource =
  | 'policy_block'
  | 'review_unavailable';

type PreparedToolkitReviews = {
  reviews: PreparedToolkitReview[];
  cancellation: ToolkitReviewCancellation | null;
};

type MaterializedToolCallMessage = {
  message: AIMessage;
  messageIndex: number;
  toolCalls: ToolCall[];
  replacedMessage: boolean;
};

type ToolkitReviewResults = Omit<ReviewInterruptTransition, 'type'> & {
  type: ReviewInterruptTransition['type'] | 'allow' | 'block';
};

const ToolkitReviewStateSchema = z.object({
  toolkitReviewApprovals: z.record(z.boolean()).default({}),
}).merge(PauseTaskInterruptStateSchema);

type ToolkitReviewState = z.infer<typeof ToolkitReviewStateSchema>;

function readApprovedReviewIds(state: Partial<ToolkitReviewState>) {
  return new Set(Object.entries(state.toolkitReviewApprovals ?? {})
    .filter(([, approved]) => approved)
    .map(([reviewId]) => reviewId));
}

function mergeApprovedReviewIds(
  state: Partial<ToolkitReviewState>,
  reviewIds: Set<string>,
): ToolkitReviewState['toolkitReviewApprovals'] {
  if (reviewIds.size === 0) {
    return state.toolkitReviewApprovals ?? {};
  }
  return {
    ...(state.toolkitReviewApprovals ?? {}),
    ...Object.fromEntries([...reviewIds].map((reviewId) => [reviewId, true])),
  };
}

function buildSkippedAfterCancellationResult(toolCall: ToolCall) {
  return JSON.stringify({
    ok: false,
    cancelled: true,
    skipped: true,
    toolName: toolCall.name,
    reason: 'Skipped because another tool call in this review action was cancelled before any tools executed.',
    input: toolCall.args,
    retryable: false,
    guidance: 'Do not retry this same review action. Replan from the cancellation feedback.',
  });
}

function buildToolMessage(toolCall: ToolCall, content: string) {
  return new ToolMessage({
    content,
    name: toolCall.name,
    tool_call_id: readToolCallId(toolCall),
  });
}

async function buildCandidateAuthorizationMatcher(params: {
  binding: ToolkitReviewBinding;
  input: unknown;
}): Promise<ToolAuthorizationMatcher | null> {
  const buildMatcher = params.binding.reviewPolicy.authorization?.buildMatcher;
  if (!buildMatcher) {
    return null;
  }
  try {
    return readToolAuthorizationMatcher(await buildMatcher({
      toolkitName: params.binding.toolkit.name,
      toolName: params.binding.toolName,
      input: params.input,
      operation: params.binding.operation,
    }));
  } catch {
    // Matcher construction is optional reuse metadata. A policy bug must fail
    // closed into the normal review path, never authorize the current call.
    return null;
  }
}

async function prepareToolkitToolReview(params: {
  binding: ToolkitReviewBinding;
  ctx: ToolkitReviewRuntimeContext;
  toolCall: ToolCall;
  approvedReviewIds: Set<string>;
}): Promise<ToolkitReviewPreparation> {
  const { approvedReviewIds, binding, ctx, toolCall } = params;
  if (approvedReviewIds.has(buildToolReviewIdForToolCall(binding.toolName, toolCall))) {
    return { type: 'allow' };
  }
  const currentInput = toolCall.args;
  const reviewCapabilities = reviewCapabilitiesForGlobalPolicy(ctx);
  const authorizationMatcher = await buildCandidateAuthorizationMatcher({
    binding,
    input: currentInput,
  });
  const activeAuthorization = authorizationMatcher
    && reviewCapabilities?.sessionAuthorization === true
    ? findToolAuthorization({
      authorizations: toolAuthorizationsForGlobalPolicy(ctx) ?? [],
      toolName: binding.toolName,
      candidateMatcher: authorizationMatcher,
    })
    : undefined;
  if (activeAuthorization) {
    await ctx.emitRuntimeEvent?.({
      event: 'on_runtime_event',
      name: 'tool_authorization_hit',
      data: {
        toolName: binding.toolName,
        matcherType: authorizationMatcher?.type,
        source: activeAuthorization.source,
        scope: 'thread',
      },
    });
    return { type: 'allow' };
  }
  if (binding.reviewPolicy.authorization?.buildMatcher) {
    await ctx.emitRuntimeEvent?.({
      event: 'on_runtime_event',
      name: 'tool_authorization_miss',
      data: {
        toolName: binding.toolName,
        matcherType: authorizationMatcher?.type,
        scope: 'thread',
      },
    });
  }
  const reviewSpec = await binding.reviewPolicy.request({
    toolkitName: binding.toolkit.name,
    toolName: binding.toolName,
    input: currentInput,
    operation: binding.operation,
    reviewCapabilities,
    authorizationMatcher,
  });

  if (!reviewSpec) {
    return { type: 'allow' };
  }
  if (isToolkitReviewBlock(reviewSpec)) {
    const source = 'policy_block' as const;
    return {
      type: 'cancel',
      toolCall,
      reason: reviewSpec.reason,
      source,
      content: buildCancelledToolResult({
        toolName: binding.toolName,
        toolkitName: binding.toolkit.name,
        reason: reviewSpec.reason,
        input: currentInput,
        source,
      }),
    };
  }

  const reviewPayload = buildHumanReviewInterruptPayload({
    toolName: binding.toolName,
    input: currentInput,
    review: reviewSpec,
    toolCall,
  });
  if (approvedReviewIds.has(reviewPayload.review.id)) {
    return { type: 'allow' };
  }
  return {
    type: 'review',
    review: {
      toolCall,
      toolkitName: binding.toolkit.name,
      toolName: binding.toolName,
      input: currentInput,
      operation: binding.operation,
      reviewPolicy: binding.reviewPolicy,
      authorizationMatcher,
      autoReviewContext: binding.toolkit.reviewGuidance,
      review: reviewPayload.review,
      reviewPayload,
    },
  };
}

function readLatestAIMessage(messages: BaseMessage[]): {
  message: AIMessage;
  index: number;
} | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (AIMessage.isInstance(message)) {
      return { message, index };
    }
  }
  return null;
}

function materializeAIMessageToolCalls(params: {
  aiMessage: AIMessage;
  aiMessageIndex: number;
}): MaterializedToolCallMessage {
  const toolCalls = materializeToolCallIds(
    params.aiMessage.tool_calls ?? [],
    params.aiMessageIndex,
  );
  const replacedMessage = toolCalls.some((toolCall, index) =>
    toolCall !== params.aiMessage.tool_calls?.[index]);
  return {
    message: replacedMessage
      ? cloneAIMessageWithToolCalls(params.aiMessage, toolCalls)
      : params.aiMessage,
    messageIndex: params.aiMessageIndex,
    toolCalls,
    replacedMessage,
  };
}

function toReviewInterruptReview(review: PreparedToolkitReview): ReviewInterruptReview {
  return {
    toolCall: review.toolCall,
    toolkitName: review.toolkitName,
    toolName: review.toolName,
    input: review.input,
    reviewPayload: review.reviewPayload,
    authorizationMatcher: review.authorizationMatcher,
  };
}

function buildCancelledOutcomeForReview(
  review: PreparedToolkitReview,
  reason: string,
  source: ToolkitReviewCancellationSource,
): Extract<ToolkitReviewPreparation, { type: 'cancel' }> {
  return {
    type: 'cancel',
    toolCall: review.toolCall,
    reason,
    source,
    content: buildCancelledToolResult({
      toolName: review.toolName,
      toolkitName: review.toolkitName,
      reason,
      input: review.input,
      source,
    }),
  };
}

async function emitGlobalReviewAuthorizationEvent(params: {
  ctx: ToolkitReviewRuntimeContext;
  resolution: Extract<GlobalReviewPolicyResolution, { type: typeof GLOBAL_REVIEW_POLICY_RESOLUTION.AUTHORIZE }>;
  reviews: PreparedToolkitReview[];
}) {
  const policyMode = params.ctx.globalReviewPolicy?.mode;
  const eventName = globalReviewPolicyAuthorizedEventName(policyMode);
  if (!eventName) {
    return;
  }
  const firstReview = params.reviews[0];
  await params.ctx.emitRuntimeEvent?.({
    event: 'on_runtime_event',
    name: eventName,
    data: {
      policyMode,
      reason: params.resolution.reason,
      batchSize: params.reviews.length,
      toolCalls: params.reviews.map((review) => ({
        toolName: review.toolName,
        toolkitName: review.toolkitName,
      })),
      ...(params.reviews.length === 1 && firstReview
        ? {
            toolName: firstReview.toolName,
            toolkitName: firstReview.toolkitName,
          }
        : {}),
    },
  });
}

async function prepareToolkitReviews(params: {
  toolCalls: ToolCall[];
  bindingsByToolName: Map<string, ToolkitReviewBinding>;
  ctx: ToolkitReviewRuntimeContext;
  approvedReviewIds: Set<string>;
}): Promise<PreparedToolkitReviews> {
  const preparedReviews: PreparedToolkitReview[] = [];
  let cancellation: ToolkitReviewCancellation | null = null;

  for (const toolCall of params.toolCalls) {
    const binding = params.bindingsByToolName.get(toolCall.name);
    if (!binding) {
      continue;
    }
    const preparation = await prepareToolkitToolReview({
      binding,
      ctx: params.ctx,
      toolCall,
      approvedReviewIds: params.approvedReviewIds,
    });
    if (preparation.type === 'allow') {
      continue;
    }
    if (preparation.type === 'review') {
      preparedReviews.push(preparation.review);
      continue;
    }
    cancellation = preparation;
    break;
  }

  return {
    reviews: preparedReviews,
    cancellation,
  };
}

async function resolveHumanToolkitReviews(params: {
  reviews: ReviewInterruptReview[];
  messages: BaseMessage[];
  reviewedMessage: MaterializedToolCallMessage;
}): Promise<ReviewInterruptTransition> {
  return new ReviewInterrupt({
    reviews: params.reviews,
    messages: params.messages,
    aiMessage: params.reviewedMessage.message,
    aiMessageIndex: params.reviewedMessage.messageIndex,
    actionWasMaterialized: params.reviewedMessage.replacedMessage,
  }).run();
}

async function reviewToolkitToolCalls(params: {
  messages: BaseMessage[];
  reviewedMessage: MaterializedToolCallMessage;
  bindingsByToolName: Map<string, ToolkitReviewBinding>;
  ctx: ToolkitReviewRuntimeContext;
  approvedReviewIds: Set<string>;
}): Promise<ToolkitReviewResults> {
  const prepared = await prepareToolkitReviews({
    toolCalls: params.reviewedMessage.toolCalls,
    bindingsByToolName: params.bindingsByToolName,
    ctx: params.ctx,
    approvedReviewIds: params.approvedReviewIds,
  });
  if (prepared.cancellation) {
    return buildPolicyCancellationResult({
      messages: params.messages,
      reviewedMessage: params.reviewedMessage,
      cancellation: prepared.cancellation,
    });
  }

  if (prepared.reviews.length === 0) {
    return buildAllowedToolkitReviewResult(params.messages, params.reviewedMessage);
  }

  const hasPendingResume = hasPendingReviewInterruptResume();
  const deterministicallyAutoAuthorized = !hasPendingResume
    && await canAutoAuthorizeCompleteBatch({
      ctx: params.ctx,
      reviews: prepared.reviews,
    });
  const policyResolution = hasPendingResume
    ? { type: GLOBAL_REVIEW_POLICY_RESOLUTION.REQUIRE_AUTHORIZATION } as const
    : deterministicallyAutoAuthorized
      ? {
          type: GLOBAL_REVIEW_POLICY_RESOLUTION.AUTHORIZE,
          reason: 'Every action passed its deterministic toolkit auto-authorization policy.',
        } as const
      : await resolveGlobalReviewBatchPolicy({
          policy: params.ctx.globalReviewPolicy,
          models: params.ctx.models,
          actor: params.ctx.actor,
          messages: params.ctx.messages,
          task: params.ctx.reviewContext?.task,
          workdir: params.ctx.reviewContext?.workdir,
          reviews: prepared.reviews,
        });

  if (policyResolution.type === GLOBAL_REVIEW_POLICY_RESOLUTION.AUTHORIZE) {
    const sessionAuthorizations = await buildAutoReviewSessionAuthorizations({
      ctx: params.ctx,
      reviews: prepared.reviews,
    });
    // AUTO_AUTHORIZED is already the user-facing event for this decision.
    // The chat adapter treats auto_review record diagnostics as non-visible.
    await recordToolAuthorizations(params.ctx, sessionAuthorizations);
    await emitGlobalReviewAuthorizationEvent({
      ctx: params.ctx,
      resolution: policyResolution,
      reviews: prepared.reviews,
    });
    return buildAllowedToolkitReviewResult(params.messages, params.reviewedMessage);
  }

  if (!runtimeCanCollectHumanReview(params.ctx)) {
    const [firstReview] = prepared.reviews;
    return buildPolicyCancellationResult({
      messages: params.messages,
      reviewedMessage: params.reviewedMessage,
      cancellation: buildCancelledOutcomeForReview(
        firstReview,
        buildHumanReviewUnavailableReason(policyResolution),
        'review_unavailable',
      ),
    });
  }

  return resolveHumanToolkitReviews({
    reviews: prepared.reviews.map(toReviewInterruptReview),
    messages: params.messages,
    reviewedMessage: params.reviewedMessage,
  });
}

async function canAutoAuthorizeCompleteBatch(params: {
  ctx: ToolkitReviewRuntimeContext;
  reviews: PreparedToolkitReview[];
}) {
  if (
    params.ctx.globalReviewPolicy?.mode !== GLOBAL_REVIEW_POLICY_MODE.AUTO_AUTHORIZATION
    || params.reviews.length === 0
  ) {
    return false;
  }

  for (const review of params.reviews) {
    const authorize = review.reviewPolicy.authorization?.authorize;
    if (!authorize) return false;
    try {
      const authorized = await authorize({
        toolkitName: review.toolkitName,
        toolName: review.toolName,
        input: review.input,
        operation: review.operation,
        workdir: params.ctx.reviewContext?.workdir ?? null,
      });
      if (!authorized) return false;
    } catch {
      return false;
    }
  }
  return true;
}

function buildAllowedToolkitReviewResult(
  messages: BaseMessage[],
  reviewedMessage: MaterializedToolCallMessage,
): ToolkitReviewResults {
  return {
    type: 'allow',
    authorizations: [],
    approvedReviewIds: [],
    stateUpdate: reviewedMessage.replacedMessage
      ? {
          messages: replaceMessageInState(
            messages,
            reviewedMessage.messageIndex,
            reviewedMessage.message,
            [],
          ),
        }
      : {},
  };
}

function buildPolicyCancellationResult(params: {
  messages: BaseMessage[];
  reviewedMessage: MaterializedToolCallMessage;
  cancellation: ToolkitReviewCancellation;
}): ToolkitReviewResults {
  const toolMessages: ToolMessage[] = [];
  for (const toolCall of params.reviewedMessage.toolCalls) {
    toolMessages.push(buildToolMessage(
      toolCall,
      readToolCallId(toolCall) === readToolCallId(params.cancellation.toolCall)
        ? params.cancellation.content
        : buildSkippedAfterCancellationResult(toolCall),
    ));
  }
  return {
    type: 'block',
    authorizations: [],
    approvedReviewIds: [],
    stateUpdate: {
      messages: replaceMessageInState(
        params.messages,
        params.reviewedMessage.messageIndex,
        params.reviewedMessage.message,
        [
          ...toolMessages,
          new AIMessage({
            content: params.cancellation.source === 'policy_block'
              ? `工具调用 ${params.cancellation.toolCall.name} 被策略阻止，未执行。原因：${params.cancellation.reason}`
              : `工具调用 ${params.cancellation.toolCall.name} 需要人工确认，但当前运行环境无法收集确认，因此未执行。原因：${params.cancellation.reason}`,
          }),
        ],
      ),
      jumpTo: 'end',
    },
  };
}

export function createToolkitReviewMiddleware(
  bindings: ToolkitReviewBinding[],
  ctx: ToolkitReviewRuntimeContext,
): AnyAgentMiddleware | null {
  if (bindings.length === 0) {
    return null;
  }
  const bindingsByToolName = new Map(bindings.map((binding) => [binding.toolName, binding]));

  return createMiddleware({
    name: 'ToolkitReviewMiddleware',
    stateSchema: ToolkitReviewStateSchema,
    afterModel: {
      hook: async (state) => {
        const messages = Array.isArray(state.messages) ? state.messages : [];
        const latestAIMessage = readLatestAIMessage(messages);
        if (!latestAIMessage?.message.tool_calls?.length) {
          return undefined;
        }
        const reviewedMessage = materializeAIMessageToolCalls({
          aiMessage: latestAIMessage.message,
          aiMessageIndex: latestAIMessage.index,
        });
        const reviewResults = await reviewToolkitToolCalls({
          messages,
          reviewedMessage,
          bindingsByToolName,
          ctx,
          approvedReviewIds: readApprovedReviewIds(state),
        });
        await recordToolAuthorizations(ctx, reviewResults.authorizations);
        const approvedReviewIds = new Set(reviewResults.approvedReviewIds);
        const approvalUpdate = approvedReviewIds.size > 0
          ? { toolkitReviewApprovals: mergeApprovedReviewIds(state, approvedReviewIds) }
          : {};
        return {
          ...approvalUpdate,
          ...reviewResults.stateUpdate,
        };
      },
      canJumpTo: ['model', 'end'],
    },
  });
}
