import { createHash } from 'node:crypto';
import { AIMessage, RemoveMessage, ToolMessage, type BaseMessage, type ToolCall } from '@langchain/core/messages';
import type { StructuredTool } from '@langchain/core/tools';
import { REMOVE_ALL_MESSAGES, interrupt } from '@langchain/langgraph';
import { createMiddleware, type AnyAgentMiddleware } from 'langchain';
import { z } from 'zod';
import type { AgentActor, AgentModels } from '../../types/agent';
import type { CapabilityRuntime } from '../../types/capability';
import type { AgentExecution } from '../../types/agent';
import type {
  AgentToolkit,
  AgentToolset,
  ToolkitContext,
  ToolkitToolReviewPolicy,
  ToolOperationMetadata,
} from '../../types/toolkit';
import type { SubagentToolOperationMetadata } from '../../types/subagent';
import {
  applyReviewEffects,
  ReviewEffectApplicationError,
  type ToolAuthorizationRecord,
} from './review/reviewAuthorizations';
import {
  resolveHumanReviewResume,
  ReviewResponseResolutionError,
} from './review/reviewResponseResolver';
import {
  appendReviewViewMessage,
  reviewViewToText,
} from './review/reviewSpec';
import type {
  PendingReviewAction,
  ReviewResponseResolution,
  ReviewSpec,
  HumanReviewInterruptPayload,
} from './review/reviewSpec';
import {
  GLOBAL_REVIEW_POLICY_MODE,
  GLOBAL_REVIEW_POLICY_RESOLUTION,
  GLOBAL_REVIEW_POLICY_RUNTIME_EVENT,
  resolveGlobalReviewBatchPolicy,
  type GlobalReviewPolicyBatchItem,
  type GlobalReviewPolicyResolution,
} from './review/globalReviewPolicy';
import type { MessageLane } from './types';

export function buildDelegationHandoffInstruction(params: {
  lane: MessageLane;
  task: string | null;
  contextSummary: string | null;
  workdir?: string | null;
}) {
  const lines = [
    '## 当前任务',
    '这是 orchestrator 下发给你的当前任务，请优先完成这件事。',
    `- 执行器：${params.lane}`,
    params.workdir ? `- 当前工作目录：${params.workdir}` : null,
    params.workdir ? '- 相对路径默认相对于当前工作目录。' : null,
    params.task ? `- 当前任务：${params.task}` : null,
    params.contextSummary ? `- 上下文摘要：${params.contextSummary}` : null,
    '- 不要重新做路由判断；如果信息足够，就直接完成当前任务。',
  ].filter(Boolean);

  return lines.join('\n');
}

export async function resolveInstructions(
  runtime: CapabilityRuntime,
  params: {
    models: AgentModels;
    actor: AgentActor;
    messages?: BaseMessage[];
    availableToolkits?: ReadonlyArray<{ name: string; description: string }>;
  },
  execution?: AgentExecution,
): Promise<string[]> {
  if (!runtime.instructions) return [];
  if (typeof runtime.instructions === 'function') {
    return runtime.instructions({
      models: params.models,
      actor: params.actor,
      messages: params.messages ?? [],
      execution,
      availableToolkits: params.availableToolkits,
    });
  }
  return runtime.instructions;
}

export function selectCapabilityTools(runtime: CapabilityRuntime, toolkitTools: StructuredTool[]) {
  const selectedTools: StructuredTool[] = [];
  const selectedNames = new Set<string>();

  function addTool(toolItem: StructuredTool) {
    if (selectedNames.has(toolItem.name)) {
      return;
    }
    selectedNames.add(toolItem.name);
    selectedTools.push(toolItem);
  }

  for (const toolItem of toolkitTools) {
    addTool(toolItem);
  }

  for (const toolset of runtime.toolsets ?? []) {
    for (const toolItem of toolset.tools) {
      addTool(toolItem);
    }
  }

  return selectedTools;
}

export function collectToolkitOperations(
  toolkits: AgentToolkit[],
): Record<string, SubagentToolOperationMetadata> {
  const operations: Record<string, SubagentToolOperationMetadata> = {};

  for (const toolkit of toolkits) {
    for (const [toolName, metadata] of Object.entries(toolkit.operations ?? {})) {
      operations[toolName] = {
        ...metadata,
        source: {
          provider: 'toolkit',
          name: toolkit.name,
          toolName,
        },
      };
    }
  }

  return operations;
}

export function collectToolsetOperations(
  toolsets: AgentToolset[] | undefined,
): Record<string, SubagentToolOperationMetadata> {
  const operations: Record<string, SubagentToolOperationMetadata> = {};

  for (const toolset of toolsets ?? []) {
    for (const [toolName, metadata] of Object.entries(toolset.operations ?? {})) {
      operations[toolName] = {
        ...metadata,
        source: {
          provider: 'toolset',
          name: toolset.name ?? 'toolset',
          toolName,
        },
      };
    }
  }

  return operations;
}

export function collectGeneralOperations(
  toolkits: AgentToolkit[],
): Record<string, SubagentToolOperationMetadata> {
  return collectToolkitOperations(toolkits);
}

export function collectCapabilityOperations(
  toolkits: AgentToolkit[],
  runtime: CapabilityRuntime,
): Record<string, SubagentToolOperationMetadata> {
  const operations = collectToolkitOperations(toolkits);

  for (const [toolName, metadata] of Object.entries(collectToolsetOperations(runtime.toolsets))) {
    if (operations[toolName]) {
      continue;
    }
    operations[toolName] = metadata;
  }

  return operations;
}

async function resolveToolkitTools(toolkit: AgentToolkit, ctx: ToolkitContext) {
  if (!toolkit.tools) return [];
  return typeof toolkit.tools === 'function'
    ? await toolkit.tools(ctx)
    : toolkit.tools;
}

async function resolveToolkitInstructions(toolkit: AgentToolkit, ctx: ToolkitContext) {
  if (!toolkit.instructions) return [];
  return typeof toolkit.instructions === 'function'
    ? await toolkit.instructions(ctx)
    : toolkit.instructions;
}

function buildCancelledToolResult(params: {
  toolName: string;
  toolkitName: string;
  reason: string;
  input: unknown;
}) {
  return JSON.stringify({
    ok: false,
    cancelled: true,
    toolName: params.toolName,
    toolkitName: params.toolkitName,
    reason: params.reason,
    input: params.input,
    retryable: false,
    guidance: 'Do not retry this same tool call. Choose a safer alternative or explain why the action cannot be completed.',
  });
}

function reviewCapabilitiesForGlobalPolicy(ctx: ToolkitContext) {
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

function runtimeCanCollectHumanReview(ctx: ToolkitContext) {
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

function buildInvalidDecisionRequest(payload: HumanReviewInterruptPayload): HumanReviewInterruptPayload {
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

async function resolveRuntimeReviewResume(params: {
  reviewPayload: HumanReviewInterruptPayload;
  resume: unknown;
  toolkits: AgentToolkit[];
}): Promise<{
  resolution: ReviewResponseResolution;
  authorizations: ToolAuthorizationRecord[];
}> {
  const resolution = resolveHumanReviewResume({
    reviewSpec: params.reviewPayload.review,
    ...(params.reviewPayload.pendingAction ? { pendingAction: params.reviewPayload.pendingAction } : {}),
  }, params.resume);
  if (resolution.effects.length > 0 && !params.reviewPayload.pendingAction) {
    throw new ReviewEffectApplicationError(
      'missing_pending_action',
      'Cannot apply review effects without a pending action.',
    );
  }
  const authorizations = params.reviewPayload.pendingAction
    ? await applyReviewEffects({
        pendingAction: params.reviewPayload.pendingAction,
        effects: resolution.effects,
        toolkits: params.toolkits,
      })
    : [];
  return { resolution, authorizations };
}

async function recordToolAuthorizations(
  ctx: ToolkitContext,
  authorizations: ToolAuthorizationRecord[],
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
  await ctx.emitRuntimeEvent?.({
    event: 'on_runtime_event',
    name: 'tool_authorization_recorded',
    data: { authorizations },
  });
}

type ToolkitReviewBinding = {
  toolkit: AgentToolkit;
  toolName: string;
  reviewPolicy: ToolkitToolReviewPolicy;
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
  | { type: 'cancel'; toolCall: ToolCall; content: string };

type MaterializedToolCallMessage = {
  message: AIMessage;
  toolCalls: ToolCall[];
  replacedMessage: boolean;
};

type ToolkitReviewResults = {
  cancelledToolCallIds: Set<string>;
  toolMessages: ToolMessage[];
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
    reason: 'Skipped because another tool call in this batch was cancelled before any tools executed.',
    input: toolCall.args,
    retryable: false,
    guidance: 'Do not retry this same tool-call batch. Replan from the cancellation feedback.',
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
  ctx: ToolkitContext;
  toolCall: ToolCall;
  approvedReviewIds: Set<string>;
}): Promise<ToolkitReviewPreparation> {
  const { approvedReviewIds, binding, ctx, toolCall } = params;
  if (approvedReviewIds.has(buildToolReviewIdForToolCall(binding.toolName, toolCall))) {
    return { type: 'allow' };
  }
  const currentInput = toolCall.args;
  const reviewSpec = await binding.reviewPolicy.request({
    ...ctx,
    reviewCapabilities: reviewCapabilitiesForGlobalPolicy(ctx),
    toolkitName: binding.toolkit.name,
    toolName: binding.toolName,
    input: currentInput,
    operation: binding.operation,
  });

  if (!reviewSpec) {
    return { type: 'allow' };
  }
  if (isToolkitReviewBlock(reviewSpec)) {
    return {
      type: 'cancel',
      toolCall,
      content: buildCancelledToolResult({
        toolName: binding.toolName,
        toolkitName: binding.toolkit.name,
        reason: reviewSpec.reason,
        input: currentInput,
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
      review: reviewPayload.review,
      reviewPayload,
    },
  };
}

async function resolveHumanToolkitReview(params: {
  review: PreparedToolkitReview;
  toolkits: AgentToolkit[];
}): Promise<
  | {
      type: 'allow';
      approvedReviewId: string;
      authorizations: ToolAuthorizationRecord[];
    }
  | { type: 'cancel'; toolCall: ToolCall; content: string }
> {
  const { review, toolkits } = params;
  let reviewResume = interrupt(review.reviewPayload);
  let reviewDecision: ReviewResponseResolution['decision'] | null = null;
  let authorizations: ToolAuthorizationRecord[] = [];
  while (!reviewDecision) {
    try {
      const resolved = await resolveRuntimeReviewResume({
        reviewPayload: review.reviewPayload,
        resume: reviewResume,
        toolkits,
      });
      reviewDecision = resolved.resolution.decision;
      authorizations = resolved.authorizations;
    } catch (error) {
      if (
        !(error instanceof ReviewResponseResolutionError)
        && !(error instanceof ReviewEffectApplicationError)
      ) {
        throw error;
      }
      reviewResume = interrupt(buildInvalidDecisionRequest(review.reviewPayload));
    }
  }

  if (reviewDecision.type === 'approve') {
    return { type: 'allow', approvedReviewId: review.reviewPayload.review.id, authorizations };
  }

  const reason = reviewDecision.type === 'respond'
    ? reviewDecision.message
    : reviewDecision.message ?? 'tool call rejected by user';
  return {
    type: 'cancel',
    toolCall: review.toolCall,
    content: buildCancelledToolResult({
      toolName: review.toolName,
      toolkitName: review.toolkitName,
      reason,
      input: review.input,
    }),
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
    toolCalls,
    replacedMessage,
  };
}

function buildCancelledOutcomeForReview(
  review: PreparedToolkitReview,
  reason: string,
): Extract<ToolkitReviewPreparation, { type: 'cancel' }> {
  return {
    type: 'cancel',
    toolCall: review.toolCall,
    content: buildCancelledToolResult({
      toolName: review.toolName,
      toolkitName: review.toolkitName,
      reason,
      input: review.input,
    }),
  };
}

async function emitGlobalReviewBatchAuthorization(params: {
  ctx: ToolkitContext;
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
      ...(params.resolution.confidence ? { confidence: params.resolution.confidence } : {}),
      ...(params.reviews.length === 1 && firstReview
        ? {
            toolName: firstReview.toolName,
            toolkitName: firstReview.toolkitName,
          }
        : {}),
    },
  });
}

async function reviewToolkitToolCalls(params: {
  toolCalls: ToolCall[];
  bindingsByToolName: Map<string, ToolkitReviewBinding>;
  ctx: ToolkitContext;
  toolkits: AgentToolkit[];
  approvedReviewIds: Set<string>;
}): Promise<ToolkitReviewResults> {
  const cancelledToolCallIds = new Set<string>();
  const toolMessages: ToolMessage[] = [];
  const newlyApprovedReviewIds = new Set<string>();
  const approvedAuthorizations: ToolAuthorizationRecord[] = [];
  const preparedReviews: PreparedToolkitReview[] = [];
  let cancelledOutcome: Extract<ToolkitReviewPreparation, { type: 'cancel' }> | null = null;

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
    cancelledOutcome = preparation;
    break;
  }

  if (!cancelledOutcome && preparedReviews.length > 0) {
    const policyResolution = await resolveGlobalReviewBatchPolicy({
      policy: params.ctx.globalReviewPolicy,
      models: params.ctx.models,
      actor: params.ctx.actor,
      messages: params.ctx.messages,
      reviews: preparedReviews,
    });
    if (policyResolution.type === GLOBAL_REVIEW_POLICY_RESOLUTION.AUTHORIZE) {
      await emitGlobalReviewBatchAuthorization({
        ctx: params.ctx,
        resolution: policyResolution,
        reviews: preparedReviews,
      });
    } else if (!runtimeCanCollectHumanReview(params.ctx)) {
      cancelledOutcome = buildCancelledOutcomeForReview(
        preparedReviews[0],
        buildHumanReviewUnavailableReason(policyResolution),
      );
    } else {
      for (const review of preparedReviews) {
        if (params.approvedReviewIds.has(review.reviewPayload.review.id)) {
          continue;
        }
        const outcome = await resolveHumanToolkitReview({
          review,
          toolkits: params.toolkits,
        });
        if (outcome.type === 'allow') {
          newlyApprovedReviewIds.add(outcome.approvedReviewId);
          params.approvedReviewIds.add(outcome.approvedReviewId);
          approvedAuthorizations.push(...outcome.authorizations);
          continue;
        }
        cancelledOutcome = outcome;
        newlyApprovedReviewIds.clear();
        break;
      }
    }
  }

  if (cancelledOutcome) {
    for (const toolCall of params.toolCalls) {
      cancelledToolCallIds.add(readToolCallId(toolCall));
      toolMessages.push(buildToolMessage(
        toolCall,
        toolCall === cancelledOutcome.toolCall
          ? cancelledOutcome.content
          : buildSkippedAfterCancellationResult(toolCall),
      ));
    }
  } else {
    await recordToolAuthorizations(params.ctx, approvedAuthorizations);
  }

  return {
    cancelledToolCallIds,
    toolMessages,
    newlyApprovedReviewIds,
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
    return reviewedMessage.replacedMessage
      ? {
          ...approvalUpdate,
          messages: replaceMessageInState(params.messages, params.aiMessageIndex, reviewedMessage.message, []),
        }
      : Object.keys(approvalUpdate).length > 0
        ? approvalUpdate
        : undefined;
  }

  const hasPendingToolCalls = reviewedMessage.toolCalls.some(
    (toolCall) => !reviewResults.cancelledToolCallIds.has(readToolCallId(toolCall)),
  );
  return {
    ...approvalUpdate,
    messages: replaceMessageInState(
      params.messages,
      params.aiMessageIndex,
      reviewedMessage.message,
      reviewResults.toolMessages,
    ),
    ...(hasPendingToolCalls ? {} : { jumpTo: 'model' as const }),
  };
}

function createToolkitReviewMiddleware(
  bindings: ToolkitReviewBinding[],
  ctx: ToolkitContext,
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
      canJumpTo: ['model'],
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
    },
  });
}

export async function resolveToolkitResources(
  toolkits: AgentToolkit[],
  names: string[] | undefined,
  ctx: ToolkitContext,
  options: { includeInstructions?: boolean } = {},
) {
  const selectedToolkits = names === undefined
    ? toolkits
    : names.map((name) => {
      const toolkit = toolkits.find((item) => item.name === name);
      if (!toolkit) {
        throw new Error(`Unknown toolkit requested: ${name}`);
      }
      return toolkit;
    });

  const tools: StructuredTool[] = [];
  const instructions: string[] = [];
  const reviewBindings: ToolkitReviewBinding[] = [];
  for (const toolkit of selectedToolkits) {
    const toolkitTools = await resolveToolkitTools(toolkit, ctx);
    tools.push(...toolkitTools);
    if (ctx.globalReviewPolicy?.mode !== GLOBAL_REVIEW_POLICY_MODE.FULL_ACCESS) {
      for (const toolItem of toolkitTools) {
        const reviewPolicy = toolkit.policy?.toolReview?.[toolItem.name];
        if (!reviewPolicy) {
          continue;
        }
        reviewBindings.push({
          toolkit,
          toolName: toolItem.name,
          reviewPolicy,
          operation: toolkit.operations?.[toolItem.name],
        });
      }
    }
    if (options.includeInstructions !== false) {
      instructions.push(...await resolveToolkitInstructions(toolkit, ctx));
    }
  }
  const reviewMiddleware = createToolkitReviewMiddleware(reviewBindings, ctx, selectedToolkits);

  return {
    toolkits: selectedToolkits,
    tools,
    instructions,
    middleware: reviewMiddleware ? [reviewMiddleware] : [],
  };
}
