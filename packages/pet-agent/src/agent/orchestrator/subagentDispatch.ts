import type { HumanMessage } from '@langchain/core/messages';
import type { StructuredTool } from '@langchain/core/tools';
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
import {
  ARTIFACT_DISCOVERY_LIST_TOOL_NAME,
  ARTIFACT_DISCOVERY_READ_TOOL_NAME,
} from './artifacts/discovery';
import { indentXmlBlock, xmlTextBlock } from './prompts/shared';
import { createInvocationContextMessage } from '../modelContext/invocationContext';

export const CAPABILITY_RUNTIME_CONTEXT_MESSAGE_NAME = 'capability_runtime_context';

/** Invocation-only runtime facts and conditional interfaces for one delegation. */
export function buildCapabilityRuntimeContextMessage(params: {
  workdir?: string | null;
  runtimeEnvironment?: string | null;
  artifactDiscovery: boolean;
}): HumanMessage | null {
  const facts = [
    params.workdir
      ? xmlTextBlock('workdir', params.workdir, ' relative_paths="resolve_from_here"')
      : null,
    params.runtimeEnvironment
      ? xmlTextBlock('runtime_environment', params.runtimeEnvironment)
      : null,
    params.artifactDiscovery
      ? [
          '<available_interface name="artifact_discovery" evidence="possibly_stale">',
          `  <tool>${ARTIFACT_DISCOVERY_LIST_TOOL_NAME}</tool>`,
          `  <tool>${ARTIFACT_DISCOVERY_READ_TOOL_NAME}</tool>`,
          '</available_interface>',
        ].join('\n')
      : null,
  ].filter((fact): fact is string => fact !== null);

  if (facts.length === 0) return null;

  return createInvocationContextMessage({
    name: CAPABILITY_RUNTIME_CONTEXT_MESSAGE_NAME,
    content: [
      '<capability_runtime_context role="fact" source="host_runtime" authority="none">',
      ...facts.map((fact) => indentXmlBlock(fact, 2)),
      '</capability_runtime_context>',
    ].join('\n'),
  });
}

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
  for (const toolkit of selectedToolkits) {
    const boundDefinitions = toolkit.tools.filter((definition) => (
      supportsInputModalities(definition.requiresInputModalities, ctx.modelInputModalities)
    ));
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

  return {
    toolkits: selectedToolkits,
    tools,
    middleware: reviewMiddleware ? [reviewMiddleware] : [],
  };
}
