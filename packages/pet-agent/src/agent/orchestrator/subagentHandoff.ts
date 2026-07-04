import { AIMessage, ToolMessage, type BaseMessage, type ToolCall } from '@langchain/core/messages';
import type { StructuredTool } from '@langchain/core/tools';
import { interrupt } from '@langchain/langgraph';
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
  resolveGlobalReviewPolicy,
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

function readToolCallId(toolCall: ToolCall) {
  const id = toolCall.id;
  return typeof id === 'string' && id.trim() ? id.trim() : 'pending_action';
}

function materializeToolCallId(toolCall: ToolCall): ToolCall {
  const actionId = readToolCallId(toolCall);
  return toolCall.id === actionId ? toolCall : { ...toolCall, id: actionId };
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

type ToolkitReviewOutcome =
  | { type: 'allow'; approvedReviewId?: string }
  | { type: 'cancel'; toolCall: ToolCall; content: string };

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

async function reviewToolkitToolCall(params: {
  binding: ToolkitReviewBinding;
  ctx: ToolkitContext;
  toolCall: ToolCall;
  toolkits: AgentToolkit[];
  approvedReviewIds: Set<string>;
}): Promise<ToolkitReviewOutcome> {
  const { approvedReviewIds, binding, ctx, toolCall, toolkits } = params;
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
      toolCall: materializeToolCallId(toolCall),
      content: buildCancelledToolResult({
        toolName: binding.toolName,
        toolkitName: binding.toolkit.name,
        reason: reviewSpec.reason,
        input: currentInput,
      }),
    };
  }

  const policyResolution = await resolveGlobalReviewPolicy({
    policy: ctx.globalReviewPolicy,
    models: ctx.models,
    actor: ctx.actor,
    messages: ctx.messages,
    toolkitName: binding.toolkit.name,
    toolName: binding.toolName,
    input: currentInput,
    operation: binding.operation,
    review: reviewSpec,
  });

  if (policyResolution.type === GLOBAL_REVIEW_POLICY_RESOLUTION.AUTHORIZE) {
    const policyMode = ctx.globalReviewPolicy?.mode;
    const eventName = globalReviewPolicyAuthorizedEventName(policyMode);
    if (eventName) {
      await ctx.emitRuntimeEvent?.({
        event: 'on_runtime_event',
        name: eventName,
        data: {
          toolName: binding.toolName,
          toolkitName: binding.toolkit.name,
          policyMode,
          reason: policyResolution.reason,
          ...(policyResolution.confidence ? { confidence: policyResolution.confidence } : {}),
        },
      });
    }
    return { type: 'allow' };
  }

  if (!runtimeCanCollectHumanReview(ctx)) {
    return {
      type: 'cancel',
      toolCall: materializeToolCallId(toolCall),
      content: buildCancelledToolResult({
        toolName: binding.toolName,
        toolkitName: binding.toolkit.name,
        reason: buildHumanReviewUnavailableReason(policyResolution),
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
  let reviewResume = interrupt(reviewPayload);
  let reviewDecision: ReviewResponseResolution['decision'] | null = null;
  let authorizations: ToolAuthorizationRecord[] = [];
  while (!reviewDecision) {
    try {
      const resolved = await resolveRuntimeReviewResume({
        reviewPayload,
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
      reviewResume = interrupt(buildInvalidDecisionRequest(reviewPayload));
    }
  }

  if (reviewDecision.type === 'approve') {
    await recordToolAuthorizations(ctx, authorizations);
    return { type: 'allow', approvedReviewId: reviewPayload.review.id };
  }

  const reason = reviewDecision.type === 'respond'
    ? reviewDecision.message
    : reviewDecision.message ?? 'tool call rejected by user';
  return {
    type: 'cancel',
    toolCall: materializeToolCallId(toolCall),
    content: buildCancelledToolResult({
      toolName: binding.toolName,
      toolkitName: binding.toolkit.name,
      reason,
      input: currentInput,
    }),
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
        const lastMessage = [...messages].reverse().find((message) => AIMessage.isInstance(message));
        if (!lastMessage?.tool_calls?.length) {
          return undefined;
        }

        const reviewedToolCalls = lastMessage.tool_calls.map(materializeToolCallId);
        lastMessage.tool_calls = reviewedToolCalls;
        const cancelledToolCallIds = new Set<string>();
        const toolMessages: ToolMessage[] = [];
        const approvedReviewIds = readApprovedReviewIds(state);
        const newlyApprovedReviewIds = new Set<string>();
        for (const toolCall of reviewedToolCalls) {
          const binding = bindingsByToolName.get(toolCall.name);
          if (!binding) {
            continue;
          }
          const outcome = await reviewToolkitToolCall({
            binding,
            ctx,
            toolCall,
            toolkits,
            approvedReviewIds,
          });
          if (outcome.type === 'allow') {
            if (outcome.approvedReviewId) {
              newlyApprovedReviewIds.add(outcome.approvedReviewId);
            }
            continue;
          }
          cancelledToolCallIds.add(readToolCallId(outcome.toolCall));
          toolMessages.push(new ToolMessage({
            content: outcome.content,
            name: outcome.toolCall.name,
            tool_call_id: readToolCallId(outcome.toolCall),
          }));
        }

        if (toolMessages.length === 0) {
          return newlyApprovedReviewIds.size > 0
            ? { toolkitReviewApprovals: mergeApprovedReviewIds(state, newlyApprovedReviewIds) }
            : undefined;
        }

        const hasPendingToolCalls = reviewedToolCalls.some(
          (toolCall) => !cancelledToolCallIds.has(readToolCallId(toolCall)),
        );
        return {
          toolkitReviewApprovals: mergeApprovedReviewIds(state, newlyApprovedReviewIds),
          messages: [lastMessage, ...toolMessages],
          ...(hasPendingToolCalls ? {} : { jumpTo: 'model' as const }),
        };
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
