import type { BaseMessage } from '@langchain/core/messages';
import { ToolMessage } from '@langchain/core/messages/tool';
import { tool, type StructuredTool, type ToolRuntime } from '@langchain/core/tools';
import { interrupt } from '@langchain/langgraph';
import type { AgentActor, AgentModels } from '../../types/agent';
import type { CapabilityRuntime } from '../../types/capability';
import type { AgentExecution } from '../../types/agent';
import type { AgentToolkit, AgentToolset, ToolkitContext } from '../../types/toolkit';
import type { SubagentToolOperationMetadata } from '../../types/subagent';
import type { HumanReviewRequest } from './humanReview';
import { readFirstHumanReviewDecision } from './humanReview';
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
  params: { models: AgentModels; actor: AgentActor },
  execution?: AgentExecution,
): Promise<string[]> {
  if (!runtime.instructions) return [];
  if (typeof runtime.instructions === 'function') {
    return runtime.instructions({
      models: params.models,
      actor: params.actor,
      messages: [],
      execution,
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
          name: toolName,
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
          provider: 'capability',
          name: toolName,
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

function buildInvalidDecisionRequest(request: HumanReviewRequest): HumanReviewRequest {
  return {
    ...request,
    error: 'invalid_decision',
    prompt: `${request.prompt ?? '当前工具调用需要确认。'}\n\n无法识别你的决定。请批准、拒绝、编辑待执行工具调用，或直接输入新的处理方向。`,
  };
}

function wrapToolkitTool(
  toolkit: AgentToolkit,
  toolItem: StructuredTool,
  ctx: ToolkitContext,
): StructuredTool {
  const reviewPolicy = toolkit.policy?.toolReview?.[toolItem.name];
  if (!reviewPolicy) {
    return toolItem;
  }

  return tool(
    async (input: unknown, runtime: ToolRuntime) => {
      let currentInput = input;

      while (true) {
        const reviewRequest = await reviewPolicy.request({
          ...ctx,
          toolkitName: toolkit.name,
          toolName: toolItem.name,
          input: currentInput,
        });

        if (!reviewRequest) {
          return toolItem.invoke(currentInput as never, runtime as never);
        }

        let reviewDecision = readFirstHumanReviewDecision(interrupt(reviewRequest));
        while (!reviewDecision) {
          reviewDecision = readFirstHumanReviewDecision(interrupt(
            buildInvalidDecisionRequest(reviewRequest),
          ));
        }

        if (reviewDecision.type === 'approve') {
          return toolItem.invoke(currentInput as never, runtime as never);
        }

        if (reviewDecision.type === 'edit') {
          currentInput = reviewPolicy.applyEdit
            ? await reviewPolicy.applyEdit({
              ...ctx,
              toolkitName: toolkit.name,
              toolName: toolItem.name,
              input: currentInput,
              editedAction: reviewDecision.editedAction,
            })
            : reviewDecision.editedAction.args;
          continue;
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
    tools.push(...toolkitTools.map((toolItem) => wrapToolkitTool(toolkit, toolItem, ctx)));
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
