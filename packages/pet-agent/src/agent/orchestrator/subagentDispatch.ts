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
/** Runtime facts and conditional interfaces available to this execution. */
export function buildSubagentExecutionContext(params: {
  workdir?: string | null;
  artifactDiscovery: boolean;
}): string | null {
  const sections = [
    params.workdir
      ? [
          '## 执行上下文',
          `- 当前工作目录：${params.workdir}`,
          '- 相对路径默认相对于当前工作目录。',
        ].join('\n')
      : null,
    ...(params.artifactDiscovery
      ? [
          [
            '## 可选历史 artifacts',
            `消息中的 <artifact_discovery_context> 表示可使用 ${ARTIFACT_DISCOVERY_LIST_TOOL_NAME} 和 ${ARTIFACT_DISCOVERY_READ_TOOL_NAME} 查找并读取当前 thread 的历史产物。`,
            'Artifacts 是可能过期或不完整的参考信息；按当前任务的需要选择并核验。',
          ].join('\n'),
        ]
      : []),
  ].filter((section): section is string => section !== null);

  return sections.length > 0 ? sections.join('\n\n') : null;
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
