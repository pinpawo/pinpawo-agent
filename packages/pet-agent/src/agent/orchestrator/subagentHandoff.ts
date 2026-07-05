import type { BaseMessage } from '@langchain/core/messages';
import type { StructuredTool } from '@langchain/core/tools';
import type { AgentActor, AgentModels } from '../../types/agent';
import type { CapabilityRuntime } from '../../types/capability';
import type { AgentExecution } from '../../types/agent';
import type {
  AgentToolkit,
  AgentToolset,
  ToolkitContext,
} from '../../types/toolkit';
import type { SubagentToolOperationMetadata } from '../../types/subagent';
import {
  GLOBAL_REVIEW_POLICY_MODE,
} from './review/globalReviewPolicy';
import { createToolkitReviewMiddleware, type ToolkitReviewBinding } from './toolkitReviewMiddleware';
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
