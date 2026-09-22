import type { StructuredTool } from '@langchain/core/tools';
import { createToolInputPreparationMiddleware } from './toolInputPreparation';
import type {
  AgentToolkit,
  ModelInputModality,
} from '../../types/toolkit';
import type { SubagentToolOperationMetadata } from '../../types/subagent';
import {
  GLOBAL_REVIEW_POLICY_MODE,
} from './review/globalReviewPolicy';
import {
  createToolkitReviewMiddleware,
  type ToolkitReviewBinding,
  type ToolkitReviewRuntimeContext,
} from './toolkitReviewMiddleware';
export function collectToolkitOperations(
  toolkits: AgentToolkit[],
): Record<string, SubagentToolOperationMetadata> {
  const operations: Record<string, SubagentToolOperationMetadata> = {};

  for (const toolkit of toolkits) {
    for (const definition of toolkit.tools) {
      if (!definition.operation) {
        continue;
      }
      const toolName = definition.tool.name;
      operations[toolName] = {
        ...definition.operation,
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

/**
 * A tool binds when the active model profile covers every modality it needs.
 * Profiles that do not declare modalities are treated as text-only, so a tool
 * that needs more is withheld rather than bound to a model that cannot use it.
 */
function supportsInputModalities(
  required: readonly ModelInputModality[] | undefined,
  supported: readonly ModelInputModality[] | undefined,
) {
  if (!required || required.length === 0) return true;
  const available = supported ?? ['text'];
  return required.every((modality) => available.includes(modality));
}

export async function resolveToolkitExecution(
  toolkits: AgentToolkit[],
  names: string[] | undefined,
  ctx: ToolkitReviewRuntimeContext,
  toolContext: Readonly<Record<string, unknown>> = {},
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
  const reviewBindings: ToolkitReviewBinding[] = [];
  const toolBindings: Array<{ toolkit: AgentToolkit; definition: AgentToolkit['tools'][number] }> = [];
  for (const toolkit of selectedToolkits) {
    const boundDefinitions = toolkit.tools.filter((definition) => (
      supportsInputModalities(definition.requiresInputModalities, ctx.modelInputModalities)
    ));
    toolBindings.push(...boundDefinitions.map(definition => ({ toolkit, definition })));
    const toolkitTools = boundDefinitions.map((definition) => definition.tool);
    tools.push(...toolkitTools);
    if (ctx.globalReviewPolicy?.mode !== GLOBAL_REVIEW_POLICY_MODE.FULL_ACCESS) {
      for (const definition of boundDefinitions) {
        if (!definition.review) {
          continue;
        }
        reviewBindings.push({
          toolkit,
          toolName: definition.tool.name,
          reviewPolicy: definition.review,
          operation: definition.operation,
        });
      }
    }
  }
  const reviewMiddleware = createToolkitReviewMiddleware(reviewBindings, ctx);
  const preparation = createToolInputPreparationMiddleware(
    toolBindings.map(({ definition }) => definition),
    toolContext,
  );

  return {
    toolkits: selectedToolkits,
    tools,
    // afterModel hooks run in reverse registration order: prepare, then review.
    middleware: [reviewMiddleware, preparation].filter((item): item is NonNullable<typeof item> => item !== null),
  };
}
