import { createHash } from 'node:crypto';
import { AIMessage, RemoveMessage, ToolMessage, type BaseMessage, type ToolCall } from '@langchain/core/messages';
import { REMOVE_ALL_MESSAGES, interrupt } from '@langchain/langgraph';
import { createMiddleware, type AnyAgentMiddleware } from 'langchain';
import { z } from 'zod';
import type {
  AgentToolkit,
  ToolkitReviewCapabilities,
  ToolReviewPolicy,
  ToolOperationMetadata,
} from '../../types/toolkit';
import type { AgentActor, AgentModels } from '../../types/agent';
import type { SubagentRuntimeEvent } from '../../types/subagent';
import {
  applyReviewEffects,
  buildToolAuthorizationRecord,
  ReviewEffectApplicationError,
  type ToolAuthorizationRecord,
} from './review/reviewAuthorizations';
import {
  isHumanReviewRunControlResume,
  resolveHumanReviewBatchResume,
  ReviewResponseResolutionError,
} from './review/reviewResponseResolver';
import { buildSubagentReviewInterruptStopNotice } from '../../subagent/guardStop';
import {
  appendReviewViewMessage,
  reviewViewToText,
} from './review/reviewSpec';
import type {
  PendingReviewAction,
  ReviewResponseResolution,
  ReviewSpec,
  HumanReviewBatchInterruptPayload,
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

export type ToolkitReviewRuntimeContext = {
  models: AgentModels;
  actor: AgentActor;
  messages: BaseMessage[];
  reviewContext?: {
    task?: string | null;
    workdir?: string | null;
  };
  reviewCapabilities?: ToolkitReviewCapabilities;
  globalReviewPolicy?: GlobalReviewPolicy;
  toolAuthorizations?: ToolAuthorizationRecord[];
  recordToolAuthorization?: (authorization: ToolAuthorizationRecord) => void | Promise<void>;
  emitRuntimeEvent?: (event: SubagentRuntimeEvent) => void | Promise<void>;
};

function buildCancelledToolResult(params: {
  toolName: string;
  toolkitName: string;
  reason: string;
  input: unknown;
  source: ToolkitReviewCancellationSource;
}) {
  const guidance = params.source === 'human_reject'
    ? 'Follow the user rejection and any updated direction. Do not retry this exact tool call unless the user explicitly asks for it.'
    : params.source === 'human_respond'
      ? 'Treat the user response as new task guidance, replan, and continue without retrying this exact tool call.'
      : params.source === 'human_interrupt'
        ? 'The run was interrupted while awaiting review. Do not retry or continue in this invocation.'
      : params.source === 'review_unavailable'
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

function buildHumanReviewActionInterruptPayload(
  reviews: PreparedToolkitReview[],
): HumanReviewBatchInterruptPayload {
  return {
    kind: 'review_batch',
    reviews: reviews.map((review) => review.reviewPayload),
  };
}

function appendInvalidDecisionMessage(
  payload: HumanReviewInterruptPayload,
): HumanReviewInterruptPayload {
  const message = '无法识别你的决定。请批准、拒绝，或直接输入新的处理方向。';
  return {
    ...payload,
    error: 'invalid_decision',
    review: {
      ...payload.review,
      view: appendReviewViewMessage(payload.review.view, message),
    },
  };
}

function buildInvalidDecisionRequest(
  payload: HumanReviewBatchInterruptPayload,
): HumanReviewBatchInterruptPayload {
  return {
    ...payload,
    error: 'invalid_decision',
    reviews: payload.reviews.map(appendInvalidDecisionMessage),
  };
}

async function buildRuntimeReviewAuthorizations(params: {
  reviewPayload: HumanReviewInterruptPayload;
  resolution: ReviewResponseResolution;
  toolkits: AgentToolkit[];
}): Promise<ToolAuthorizationRecord[]> {
  if (params.resolution.effects.length > 0 && !params.reviewPayload.pendingAction) {
    throw new ReviewEffectApplicationError(
      'missing_pending_action',
      'Cannot apply review effects without a pending action.',
    );
  }
  return params.reviewPayload.pendingAction
    ? await applyReviewEffects({
        pendingAction: params.reviewPayload.pendingAction,
        effects: params.resolution.effects,
        toolkits: params.toolkits,
      })
    : [];
}

async function recordToolAuthorizations(
  ctx: ToolkitReviewRuntimeContext,
  authorizations: ToolAuthorizationRecord[],
  options: { emitRecordedEvent?: boolean } = {},
) {
  if (authorizations.length === 0) {
    return;
  }
  if (!ctx.recordToolAuthorization) {
    throw new ReviewEffectApplicationError(
      'missing_thread',
      'Cannot apply authorization effects without an orchestrator authorization recorder.',
    );
  }
  for (const authorization of authorizations) {
    await ctx.recordToolAuthorization(authorization);
  }
  if (options.emitRecordedEvent === false) {
    return;
  }
  await ctx.emitRuntimeEvent?.({
    event: 'on_runtime_event',
    name: 'tool_authorization_recorded',
    data: { authorizations },
  });
}

/**
 * Auto review owns only the concrete batch it inspected. Reuse that approval
 * for exact matching arguments in the same checkpointed session, but never
 * widen it to a shell wildcard, URL domain, or toolkit-defined broad matcher.
 */
function buildAutoReviewSessionAuthorizations(params: {
  ctx: ToolkitReviewRuntimeContext;
  reviews: PreparedToolkitReview[];
}) {
  if (
    params.ctx.globalReviewPolicy?.mode !== GLOBAL_REVIEW_POLICY_MODE.AUTO_AUTHORIZATION
    || params.ctx.reviewCapabilities?.sessionAuthorization !== true
    || !params.ctx.recordToolAuthorization
  ) {
    return [];
  }

  return params.reviews.flatMap((review) => {
    const pendingAction = review.reviewPayload.pendingAction;
    if (!pendingAction) {
      return [];
    }
    return [buildToolAuthorizationRecord({
      toolName: review.toolName,
      matcher: {
        type: 'exact_args',
        value: { ...pendingAction.args },
      },
    })];
  });
}

export type ToolkitReviewBinding = {
  toolkit: AgentToolkit;
  toolName: string;
  reviewPolicy: ToolReviewPolicy;
  operation?: ToolOperationMetadata;
};

const ToolkitReviewStateSchema = z.object({
  toolkitReviewApprovals: z.record(z.boolean()).default({}),
});

type ToolkitReviewState = z.infer<typeof ToolkitReviewStateSchema>;

type PreparedToolkitReview = GlobalReviewPolicyBatchItem & {
  toolCall: ToolCall;
  reviewPayload: HumanReviewInterruptPayload;
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
  | 'human_reject'
  | 'human_respond'
  | 'human_interrupt'
  | 'policy_block'
  | 'review_unavailable';

type PreparedToolkitReviews = {
  reviews: PreparedToolkitReview[];
  cancellation: ToolkitReviewCancellation | null;
};

type ToolkitReviewResolution =
  | {
      type: 'authorize';
      authorizations: ToolAuthorizationRecord[];
      newlyApprovedReviewIds: Set<string>;
    }
  | {
      type: 'cancel';
      cancellation: ToolkitReviewCancellation;
    };

type MaterializedToolCallMessage = {
  message: AIMessage;
  toolCalls: ToolCall[];
  replacedMessage: boolean;
};

type ToolkitReviewResults = {
  cancelledToolCallIds: Set<string>;
  toolMessages: ToolMessage[];
  terminalMessage: AIMessage | null;
  resumeModel: boolean;
  stopRun: boolean;
  newlyApprovedReviewIds: Set<string>;
};

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
  const reviewSpec = await binding.reviewPolicy.request({
    toolkitName: binding.toolkit.name,
    toolName: binding.toolName,
    input: currentInput,
    operation: binding.operation,
    reviewCapabilities: reviewCapabilitiesForGlobalPolicy(ctx),
    toolAuthorizations: ctx.toolAuthorizations,
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
      autoReviewContext: binding.toolkit.reviewGuidance,
      review: reviewPayload.review,
      reviewPayload,
    },
  };
}

type ReviewActionResumeResolution =
  | { type: 'interrupt_run' }
  | { type: 'decisions'; resolutions: ReviewResponseResolution[] };

async function resolveReviewActionResume(params: {
  reviews: PreparedToolkitReview[];
  resume: unknown;
}): Promise<ReviewActionResumeResolution> {
  if (isHumanReviewRunControlResume(params.resume)) {
    return { type: 'interrupt_run' };
  }
  return {
    type: 'decisions',
    resolutions: resolveHumanReviewBatchResume(
      params.reviews.map((review) => ({
        reviewSpec: review.reviewPayload.review,
        ...(review.reviewPayload.pendingAction
          ? { pendingAction: review.reviewPayload.pendingAction }
          : {}),
      })),
      params.resume,
    ),
  };
}

async function authorizeApprovedReviewAction(params: {
  reviews: PreparedToolkitReview[];
  resolutions: ReviewResponseResolution[];
  toolkits: AgentToolkit[];
}): Promise<ToolAuthorizationRecord[]> {
  if (params.resolutions.length !== params.reviews.length) {
    throw new ReviewResponseResolutionError(
      'invalid_response',
      `Review action approved ${params.resolutions.length} of ${params.reviews.length} pending reviews.`,
    );
  }

  const authorizations: ToolAuthorizationRecord[] = [];
  for (let index = 0; index < params.resolutions.length; index += 1) {
    const resolution = params.resolutions[index]!;
    const review = params.reviews[index]!;
    authorizations.push(...await buildRuntimeReviewAuthorizations({
      reviewPayload: review.reviewPayload,
      resolution,
      toolkits: params.toolkits,
    }));
  }
  return authorizations;
}

function buildCancellationForDecision(
  review: PreparedToolkitReview,
  decision: ReviewResponseResolution['decision'],
): ToolkitReviewCancellation {
  const reason = decision.type === 'respond'
    ? decision.message
    : decision.type === 'reject'
      ? decision.message ?? 'tool call rejected by user'
      : 'tool call rejected by user';
  return buildCancelledOutcomeForReview(
    review,
    reason,
    decision.type === 'respond' ? 'human_respond' : 'human_reject',
  );
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
    toolCalls,
    replacedMessage,
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
  reviews: PreparedToolkitReview[];
  toolkits: AgentToolkit[];
}): Promise<ToolkitReviewResolution> {
  let reviewPayload = buildHumanReviewActionInterruptPayload(params.reviews);
  let resume = interrupt(reviewPayload);
  while (true) {
    try {
      const resumeResolution = await resolveReviewActionResume({
        reviews: params.reviews,
        resume,
      });
      if (resumeResolution.type === 'interrupt_run') {
        const firstReview = params.reviews[0];
        if (!firstReview) {
          throw new ReviewResponseResolutionError(
            'invalid_response',
            'Cannot interrupt an empty human review action.',
          );
        }
        return {
          type: 'cancel',
          cancellation: buildCancelledOutcomeForReview(
            firstReview,
            'run interrupted while waiting for human review',
            'human_interrupt',
          ),
        };
      }
      const { resolutions } = resumeResolution;
      const firstCancellation = resolutions.find((resolution) =>
        resolution.decision.type !== 'approve');
      if (firstCancellation) {
        const reviewIndex = resolutions.indexOf(firstCancellation);
        return {
          type: 'cancel',
          cancellation: buildCancellationForDecision(
            params.reviews[reviewIndex]!,
            firstCancellation.decision,
          ),
        };
      }
      const authorizations = await authorizeApprovedReviewAction({
        reviews: params.reviews,
        resolutions,
        toolkits: params.toolkits,
      });
      return {
        type: 'authorize',
        authorizations,
        newlyApprovedReviewIds: new Set(params.reviews.map((review) => review.reviewPayload.review.id)),
      };
    } catch (error) {
      if (
        !(error instanceof ReviewResponseResolutionError)
        && !(error instanceof ReviewEffectApplicationError)
      ) {
        throw error;
      }
      reviewPayload = buildInvalidDecisionRequest(reviewPayload);
      resume = interrupt(reviewPayload);
    }
  }
}

async function resolvePreparedToolkitReviews(params: {
  prepared: PreparedToolkitReviews;
  ctx: ToolkitReviewRuntimeContext;
  toolkits: AgentToolkit[];
}): Promise<ToolkitReviewResolution> {
  if (params.prepared.cancellation) {
    return {
      type: 'cancel',
      cancellation: params.prepared.cancellation,
    };
  }

  if (params.prepared.reviews.length === 0) {
    return {
      type: 'authorize',
      authorizations: [],
      newlyApprovedReviewIds: new Set<string>(),
    };
  }

  const policyResolution = await resolveGlobalReviewBatchPolicy({
    policy: params.ctx.globalReviewPolicy,
    models: params.ctx.models,
    actor: params.ctx.actor,
    messages: params.ctx.messages,
    task: params.ctx.reviewContext?.task,
    workdir: params.ctx.reviewContext?.workdir,
    reviews: params.prepared.reviews,
  });

  if (policyResolution.type === GLOBAL_REVIEW_POLICY_RESOLUTION.AUTHORIZE) {
    const sessionAuthorizations = buildAutoReviewSessionAuthorizations({
      ctx: params.ctx,
      reviews: params.prepared.reviews,
    });
    // AUTO_AUTHORIZED is already the user-facing event for this decision.
    // Persist silently to avoid emitting a second authorization notice.
    await recordToolAuthorizations(params.ctx, sessionAuthorizations, {
      emitRecordedEvent: false,
    });
    await emitGlobalReviewAuthorizationEvent({
      ctx: params.ctx,
      resolution: policyResolution,
      reviews: params.prepared.reviews,
    });
    return {
      type: 'authorize',
      authorizations: [],
      newlyApprovedReviewIds: new Set<string>(),
    };
  }

  if (!runtimeCanCollectHumanReview(params.ctx)) {
    const [firstReview] = params.prepared.reviews;
    return {
      type: 'cancel',
      cancellation: buildCancelledOutcomeForReview(
        firstReview,
        buildHumanReviewUnavailableReason(policyResolution),
        'review_unavailable',
      ),
    };
  }

  return resolveHumanToolkitReviews({
    reviews: params.prepared.reviews,
    toolkits: params.toolkits,
  });
}

function buildCancelledToolCallResults(
  toolCalls: ToolCall[],
  cancellation: ToolkitReviewCancellation,
): ToolkitReviewResults {
  const cancelledToolCallIds = new Set<string>();
  const toolMessages: ToolMessage[] = [];
  for (const toolCall of toolCalls) {
    cancelledToolCallIds.add(readToolCallId(toolCall));
    toolMessages.push(buildToolMessage(
      toolCall,
      toolCall === cancellation.toolCall
        ? cancellation.content
        : buildSkippedAfterCancellationResult(toolCall),
    ));
  }
  return {
    cancelledToolCallIds,
    toolMessages,
    terminalMessage: cancellation.source === 'policy_block'
      || cancellation.source === 'review_unavailable'
      ? new AIMessage({
          content: cancellation.source === 'policy_block'
            ? `工具调用 ${cancellation.toolCall.name} 被策略阻止，未执行。原因：${cancellation.reason}`
            : `工具调用 ${cancellation.toolCall.name} 需要人工确认，但当前运行环境无法收集确认，因此未执行。原因：${cancellation.reason}`,
        })
      : cancellation.source === 'human_interrupt'
        ? buildSubagentReviewInterruptStopNotice()
        : null,
    resumeModel: cancellation.source === 'human_reject'
      || cancellation.source === 'human_respond',
    stopRun: cancellation.source === 'human_interrupt',
    newlyApprovedReviewIds: new Set<string>(),
  };
}

async function reviewToolkitToolCalls(params: {
  toolCalls: ToolCall[];
  bindingsByToolName: Map<string, ToolkitReviewBinding>;
  ctx: ToolkitReviewRuntimeContext;
  toolkits: AgentToolkit[];
  approvedReviewIds: Set<string>;
}): Promise<ToolkitReviewResults> {
  const prepared = await prepareToolkitReviews({
    toolCalls: params.toolCalls,
    bindingsByToolName: params.bindingsByToolName,
    ctx: params.ctx,
    approvedReviewIds: params.approvedReviewIds,
  });
  const resolution = await resolvePreparedToolkitReviews({
    prepared,
    ctx: params.ctx,
    toolkits: params.toolkits,
  });

  if (resolution.type === 'cancel') {
    return buildCancelledToolCallResults(params.toolCalls, resolution.cancellation);
  }

  await recordToolAuthorizations(params.ctx, resolution.authorizations);
  return {
    cancelledToolCallIds: new Set<string>(),
    toolMessages: [],
    terminalMessage: null,
    resumeModel: false,
    stopRun: false,
    newlyApprovedReviewIds: resolution.newlyApprovedReviewIds,
  };
}

function buildToolkitReviewStateUpdate(params: {
  state: Partial<ToolkitReviewState>;
  messages: BaseMessage[];
  aiMessageIndex: number;
  reviewedMessage: MaterializedToolCallMessage;
  reviewResults: ToolkitReviewResults;
}) {
  const { reviewedMessage, reviewResults } = params;
  const approvalUpdate = reviewResults.newlyApprovedReviewIds.size > 0
    ? { toolkitReviewApprovals: mergeApprovedReviewIds(params.state, reviewResults.newlyApprovedReviewIds) }
    : {};
  if (reviewResults.toolMessages.length === 0) {
    // Return {} when no state or message updates are needed, so middleware can
    // emit a stable state object in this no-op branch.
    return reviewedMessage.replacedMessage
      ? {
          ...approvalUpdate,
          messages: replaceMessageInState(params.messages, params.aiMessageIndex, reviewedMessage.message, []),
        }
      : Object.keys(approvalUpdate).length > 0
        ? approvalUpdate
        : {};
  }

  // Once every pending tool call has a ToolMessage, LangChain's normal
  // after-model router considers the turn complete and exits the child agent.
  // Human reject/respond is task guidance, so explicitly return to the same
  // child model. Deterministic policy blocks keep their terminal semantics.
  const cancellationUpdate = reviewResults.stopRun
    ? { jumpTo: 'end' as const }
    : reviewResults.resumeModel
      ? { jumpTo: 'model' as const }
      : {};
  const appendedMessages = reviewResults.terminalMessage
    ? [...reviewResults.toolMessages, reviewResults.terminalMessage]
    : reviewResults.toolMessages;
  return {
    ...approvalUpdate,
    ...cancellationUpdate,
    messages: replaceMessageInState(
      params.messages,
      params.aiMessageIndex,
      reviewedMessage.message,
      appendedMessages,
    ),
  };
}

export function createToolkitReviewMiddleware(
  bindings: ToolkitReviewBinding[],
  ctx: ToolkitReviewRuntimeContext,
  toolkits: AgentToolkit[],
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
        const approvedReviewIds = readApprovedReviewIds(state);
        const reviewResults = await reviewToolkitToolCalls({
          toolCalls: reviewedMessage.toolCalls,
          bindingsByToolName,
          ctx,
          toolkits,
          approvedReviewIds,
        });

        return buildToolkitReviewStateUpdate({
          state,
          messages,
          aiMessageIndex: latestAIMessage.index,
          reviewedMessage,
          reviewResults,
        });
      },
      canJumpTo: ['model', 'end'],
    },
  });
}
