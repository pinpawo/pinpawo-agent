import type { BaseMessage } from '@langchain/core/messages';
import { ToolMessage } from '@langchain/core/messages/tool';
import { tool, type StructuredTool, type ToolRuntime } from '@langchain/core/tools';
import { interrupt } from '@langchain/langgraph';
import type { AgentActor, AgentModels } from '../../types/agent';
import type { CapabilityRuntime } from '../../types/capability';
import type { AgentExecution } from '../../types/agent';
import type { AgentToolkit, AgentToolset, ToolkitContext } from '../../types/toolkit';
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
import type {
  PendingReviewAction,
  ReviewResponseResolution,
  ReviewSpec,
  HumanReviewInterruptPayload,
} from './review/reviewSpec';
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

function isToolkitReviewBlock(value: unknown): value is { type: 'block'; reason: string } {
  return Boolean(
    value
    && typeof value === 'object'
    && (value as { type?: unknown }).type === 'block'
    && typeof (value as { reason?: unknown }).reason === 'string',
  );
}

function readToolCallId(runtime: ToolRuntime) {
  const record = runtime && typeof runtime === 'object'
    ? runtime as unknown as Record<string, unknown>
    : {};
  const id = record.toolCallId ?? record.tool_call_id;
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
    review.view.body,
  ].filter((item): item is string => Boolean(item && item.trim())).join('\n');
}

function buildPendingReviewAction(params: {
  toolName: string;
  input: unknown;
  review: ReviewSpec;
  runtime: ToolRuntime;
}): PendingReviewAction {
  const prompt = formatReviewPrompt(params.review);
  return {
    actionId: readToolCallId(params.runtime),
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
  runtime: ToolRuntime;
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
      view: {
        ...payload.review.view,
        body: `${payload.review.view.body}\n\n${message}`,
      },
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

function wrapToolkitTool(
  toolkit: AgentToolkit,
  toolItem: StructuredTool,
  ctx: ToolkitContext,
  toolkits: AgentToolkit[],
): StructuredTool {
  const reviewPolicy = toolkit.policy?.toolReview?.[toolItem.name];
  const operation = toolkit.operations?.[toolItem.name];
  if (!reviewPolicy) {
    return toolItem;
  }

  return tool(
    async (input: unknown, runtime: ToolRuntime) => {
      let currentInput = input;

      while (true) {
        const reviewSpec = await reviewPolicy.request({
          ...ctx,
          toolkitName: toolkit.name,
          toolName: toolItem.name,
          input: currentInput,
          operation,
        });

        if (!reviewSpec) {
          return toolItem.invoke(currentInput as never, runtime as never);
        }
        if (isToolkitReviewBlock(reviewSpec)) {
          return buildCancelledToolResult({
            toolName: toolItem.name,
            toolkitName: toolkit.name,
            reason: reviewSpec.reason,
            input: currentInput,
          });
        }

        const reviewPayload = buildHumanReviewInterruptPayload({
          toolName: toolItem.name,
          input: currentInput,
          review: reviewSpec,
          runtime,
        });
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
          return toolItem.invoke(currentInput as never, runtime as never);
        }

        const reason = reviewDecision.type === 'respond'
          ? reviewDecision.message
          : reviewDecision.message ?? 'tool call rejected by user';
        return buildCancelledToolResult({
          toolName: toolItem.name,
          toolkitName: toolkit.name,
          reason,
          input: currentInput,
        });
      }
    },
    {
      name: toolItem.name,
      description: toolItem.description,
      schema: toolItem.schema,
      responseFormat: toolItem.responseFormat,
      returnDirect: toolItem.returnDirect,
      metadata: toolItem.metadata,
      extras: toolItem.extras,
    },
  ) as StructuredTool;
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
    tools.push(...toolkitTools.map((toolItem) => wrapToolkitTool(toolkit, toolItem, ctx, selectedToolkits)));
    if (options.includeInstructions !== false) {
      instructions.push(...await resolveToolkitInstructions(toolkit, ctx));
    }
  }

  return {
    toolkits: selectedToolkits,
    tools,
    instructions,
  };
}

export function readLatestToolArtifact(messages: BaseMessage[]): unknown | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (ToolMessage.isInstance(msg) && msg.artifact !== undefined) {
      return msg.artifact;
    }
  }

  return null;
}
