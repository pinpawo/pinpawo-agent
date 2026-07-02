import { ToolMessage, type BaseMessage } from '@langchain/core/messages';
import type { StructuredTool } from '@langchain/core/tools';
import { interrupt } from '@langchain/langgraph';
import { createMiddleware, type AgentMiddleware } from 'langchain';
import type { AgentActor, AgentModels } from '../../types/agent';
import type { CapabilityRuntime } from '../../types/capability';
import type { AgentExecution } from '../../types/agent';
import type {
  AgentToolkit,
  AgentToolset,
  ToolkitContext,
  ToolkitToolReviewPolicy,
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

function readActionId(value: unknown) {
  const record = value && typeof value === 'object'
    ? value as Record<string, unknown>
    : {};
  const id = record.id ?? record.toolCallId ?? record.tool_call_id;
  return typeof id === 'string' && id.trim() ? id.trim() : 'pending_action';
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
  actionId: string;
}): PendingReviewAction {
  const prompt = formatReviewPrompt(params.review);
  return {
    actionId: params.actionId,
    toolName: params.toolName,
    args: inputToActionArgs(params.input),
    ...(prompt ? { description: prompt.split('\n')[0] } : {}),
  };
}

function buildToolReviewId(action: PendingReviewAction) {
  return `tool-review:${action.toolName}:${action.actionId}`;
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
  actionId: string;
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

type ReviewToolCall = {
  id?: string;
  name: string;
  args: Record<string, any>;
};

type ToolReviewRef = {
  toolkit: AgentToolkit;
  reviewPolicy: ToolkitToolReviewPolicy;
  operation?: SubagentToolOperationMetadata;
};

function findToolReview(toolkits: AgentToolkit[], toolName: string): ToolReviewRef | null {
  for (const toolkit of toolkits) {
    const reviewPolicy = toolkit.policy?.toolReview?.[toolName];
    if (reviewPolicy) {
      return {
        toolkit,
        reviewPolicy,
        operation: toolkit.operations?.[toolName],
      };
    }
  }
  return null;
}

function hasToolReviewPolicies(toolkits: AgentToolkit[]) {
  return toolkits.some((toolkit) => Object.keys(toolkit.policy?.toolReview ?? {}).length > 0);
}

function clipToolFeedback(value: string, limit = 160) {
  return value.length <= limit ? value : `${value.slice(0, limit)}…`;
}

function buildToolFeedbackMessage(params: {
  toolCall: ReviewToolCall;
  content: string;
  status?: 'error';
}) {
  return new ToolMessage({
    content: params.content,
    tool_call_id: readActionId(params.toolCall),
    name: params.toolCall.name,
    ...(params.status ? { status: params.status } : {}),
  });
}

async function emitGlobalPolicyAuthorizedEvent(params: {
  ctx: ToolkitContext;
  toolkitName: string;
  toolName: string;
  policyResolution: Extract<GlobalReviewPolicyResolution, { type: typeof GLOBAL_REVIEW_POLICY_RESOLUTION.AUTHORIZE }>;
}) {
  const policyMode = params.ctx.globalReviewPolicy?.mode;
  const eventName = globalReviewPolicyAuthorizedEventName(policyMode);
  if (!eventName) {
    return;
  }
  await params.ctx.emitRuntimeEvent?.({
    event: 'on_runtime_event',
    name: eventName,
    data: {
      toolName: params.toolName,
      toolkitName: params.toolkitName,
      policyMode,
      reason: params.policyResolution.reason,
      ...(params.policyResolution.confidence ? { confidence: params.policyResolution.confidence } : {}),
    },
  });
}

async function resolveReviewedToolCall(params: {
  ctx: ToolkitContext;
  toolkits: AgentToolkit[];
  toolCall: ReviewToolCall;
  reviewRef: ToolReviewRef;
}): Promise<{
  outcome: 'execute';
} | {
  outcome: 'feedback';
  toolMessage: ToolMessage;
}> {
  const { ctx, toolCall, reviewRef } = params;
  const currentInput = toolCall.args;
  const { toolkit, reviewPolicy, operation } = reviewRef;
  const reviewSpec = await reviewPolicy.request({
    ...ctx,
    reviewCapabilities: reviewCapabilitiesForGlobalPolicy(ctx),
    toolkitName: toolkit.name,
    toolName: toolCall.name,
    input: currentInput,
    operation,
  });

  if (!reviewSpec) {
    return { outcome: 'execute' };
  }

  if (isToolkitReviewBlock(reviewSpec)) {
    return {
      outcome: 'feedback',
      toolMessage: buildToolFeedbackMessage({
        toolCall,
        content: `工具调用未执行：${clipToolFeedback(reviewSpec.reason)}`,
        status: 'error',
      }),
    };
  }

  const policyResolution = await resolveGlobalReviewPolicy({
    policy: ctx.globalReviewPolicy,
    models: ctx.models,
    actor: ctx.actor,
    messages: ctx.messages,
    toolkitName: toolkit.name,
    toolName: toolCall.name,
    input: currentInput,
    operation,
    review: reviewSpec,
  });

  if (policyResolution.type === GLOBAL_REVIEW_POLICY_RESOLUTION.AUTHORIZE) {
    await emitGlobalPolicyAuthorizedEvent({
      ctx,
      toolkitName: toolkit.name,
      toolName: toolCall.name,
      policyResolution,
    });
    return { outcome: 'execute' };
  }

  if (!runtimeCanCollectHumanReview(ctx)) {
    return {
      outcome: 'feedback',
      toolMessage: buildToolFeedbackMessage({
        toolCall,
        content: `工具调用未执行：${clipToolFeedback(buildHumanReviewUnavailableReason(policyResolution))}`,
        status: 'error',
      }),
    };
  }

  const reviewPayload = buildHumanReviewInterruptPayload({
    toolName: toolCall.name,
    input: currentInput,
    review: reviewSpec,
    actionId: readActionId(toolCall),
  });
  let reviewResume = interrupt(reviewPayload);
  let reviewDecision: ReviewResponseResolution['decision'] | null = null;
  let authorizations: ToolAuthorizationRecord[] = [];
  while (!reviewDecision) {
    try {
      const resolved = await resolveRuntimeReviewResume({
        reviewPayload,
        resume: reviewResume,
        toolkits: params.toolkits,
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
    return { outcome: 'execute' };
  }

  if (reviewDecision.type === 'respond') {
    return {
      outcome: 'feedback',
      toolMessage: buildToolFeedbackMessage({
        toolCall,
        content: reviewDecision.message,
      }),
    };
  }

  return {
    outcome: 'feedback',
    toolMessage: buildToolFeedbackMessage({
      toolCall,
      content: '用户拒绝执行该工具，请停止本轮。',
      status: 'error',
    }),
  };
}

function createToolkitReviewMiddleware(
  toolkits: AgentToolkit[],
  ctx: ToolkitContext,
): AgentMiddleware | null {
  if (
    ctx.globalReviewPolicy?.mode === GLOBAL_REVIEW_POLICY_MODE.FULL_ACCESS
    || !hasToolReviewPolicies(toolkits)
  ) {
    return null;
  }

  return createMiddleware({
    name: 'PinpawoToolkitReviewMiddleware',
    wrapToolCall: async (request, handler) => {
      const toolCall = request.toolCall as ReviewToolCall;
      const reviewRef = findToolReview(toolkits, toolCall.name);
      if (!reviewRef) {
        return handler(request);
      }

      const result = await resolveReviewedToolCall({
        ctx,
        toolkits,
        toolCall,
        reviewRef,
      });
      if (result.outcome === 'execute') {
        return handler(request);
      }
      return result.toolMessage;
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
  for (const toolkit of selectedToolkits) {
    const toolkitTools = await resolveToolkitTools(toolkit, ctx);
    tools.push(...toolkitTools);
    if (options.includeInstructions !== false) {
      instructions.push(...await resolveToolkitInstructions(toolkit, ctx));
    }
  }
  const reviewMiddleware = createToolkitReviewMiddleware(selectedToolkits, ctx);

  return {
    toolkits: selectedToolkits,
    tools,
    instructions,
    middleware: reviewMiddleware ? [reviewMiddleware] : [],
  };
}
