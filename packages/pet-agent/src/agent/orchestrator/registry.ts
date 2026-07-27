import type { StructuredTool } from '@langchain/core/tools';
import type { AgentCapability } from '../../types/capability';
import type {
  AgentToolkit,
  ToolDefinition,
  ToolOperationMetadata,
  ToolReviewPolicy,
} from '../../types/toolkit';
import {
  validateUniqueCapabilityNames,
  validateUniqueToolkitNames,
} from './validation';

export type ExecutorCompilationIssue =
  | {
      code: 'duplicate_toolkit_dependency';
      toolkitName: string;
    }
  | {
      code: 'unknown_toolkit';
      toolkitName: string;
    }
  | {
      code: 'duplicate_tool';
      toolName: string;
      toolkitNames: readonly [string, string];
    };

type CompiledCapability = {
  capability: AgentCapability;
  toolkits: readonly AgentToolkit[];
  tools: readonly StructuredTool[];
  toolNames: readonly string[];
};

type UnavailableCapability = {
  capability: AgentCapability;
  issues: readonly ExecutorCompilationIssue[];
};

export type CompiledAgentRegistry = {
  toolkits: readonly AgentToolkit[];
  capabilities: readonly CompiledCapability[];
  unavailableCapabilities: readonly UnavailableCapability[];
};

function formatExecutorCompilationIssue(issue: ExecutorCompilationIssue) {
  if (issue.code === 'duplicate_toolkit_dependency') {
    return `duplicate Toolkit dependency "${issue.toolkitName}"`;
  }
  if (issue.code === 'unknown_toolkit') {
    return `unknown Toolkit "${issue.toolkitName}"`;
  }
  return `duplicate tool "${issue.toolName}" from Toolkits "${issue.toolkitNames[0]}" and "${issue.toolkitNames[1]}"`;
}

export function formatExecutorCompilationIssues(
  issues: readonly ExecutorCompilationIssue[],
) {
  return issues.map(formatExecutorCompilationIssue).join('; ');
}

function compileExecutor(
  toolkitNames: readonly string[],
  toolkitsByName: ReadonlyMap<string, AgentToolkit>,
): {
  executor: Omit<CompiledCapability, 'capability'> | null;
  issues: ExecutorCompilationIssue[];
} {
  const issues: ExecutorCompilationIssue[] = [];
  const selectedToolkits: AgentToolkit[] = [];
  const seenToolkitNames = new Set<string>();

  for (const toolkitName of toolkitNames) {
    if (seenToolkitNames.has(toolkitName)) {
      issues.push({
        code: 'duplicate_toolkit_dependency',
        toolkitName,
      });
      continue;
    }
    seenToolkitNames.add(toolkitName);

    const toolkit = toolkitsByName.get(toolkitName);
    if (!toolkit) {
      issues.push({
        code: 'unknown_toolkit',
        toolkitName,
      });
      continue;
    }
    selectedToolkits.push(toolkit);
  }

  const tools: StructuredTool[] = [];
  const toolOwners = new Map<string, string>();
  for (const toolkit of selectedToolkits) {
    for (const definition of toolkit.tools) {
      const toolName = definition.tool.name;
      const existingOwner = toolOwners.get(toolName);
      if (existingOwner) {
        issues.push({
          code: 'duplicate_tool',
          toolName,
          toolkitNames: [existingOwner, toolkit.name],
        });
        continue;
      }
      toolOwners.set(toolName, toolkit.name);
      tools.push(definition.tool);
    }
  }

  if (issues.length > 0) {
    return { executor: null, issues };
  }

  return {
    executor: {
      toolkits: Object.freeze(selectedToolkits),
      tools: Object.freeze(tools),
      toolNames: Object.freeze(tools.map((tool) => tool.name)),
    },
    issues,
  };
}

function snapshotOperation(
  operation: ToolOperationMetadata | undefined,
): ToolOperationMetadata | undefined {
  return operation ? Object.freeze({ ...operation }) : undefined;
}

function snapshotReview(
  review: ToolReviewPolicy | undefined,
): ToolReviewPolicy | undefined {
  return review ? Object.freeze({ ...review }) : undefined;
}

function snapshotToolDefinition(definition: ToolDefinition): ToolDefinition {
  // Preserve the executable Tool instance by identity: LangChain Tools may own
  // mutable runtime internals and cannot be safely cloned or deep-frozen.
  // The surrounding binding is snapshotted; by convention, hosts keep the
  // Tool name stable for the lifetime of this registry generation.
  return Object.freeze({
    tool: definition.tool,
    ...(definition.operation
      ? { operation: snapshotOperation(definition.operation) }
      : {}),
    ...(definition.review
      ? { review: snapshotReview(definition.review) }
      : {}),
  });
}

function snapshotToolkit(toolkit: AgentToolkit): AgentToolkit {
  return Object.freeze({
    ...toolkit,
    tools: Object.freeze(toolkit.tools.map(snapshotToolDefinition)),
    ...(toolkit.reviewGuidance
      ? { reviewGuidance: Object.freeze({ ...toolkit.reviewGuidance }) }
      : {}),
  });
}

function snapshotCapability(capability: AgentCapability): AgentCapability {
  return Object.freeze({
    ...capability,
    uses: Object.freeze([...capability.uses]),
    instructions: Object.freeze({ ...capability.instructions }),
    ...(capability.document
      ? { document: Object.freeze({ ...capability.document }) }
      : {}),
    ...(capability.lifecycle
      ? { lifecycle: Object.freeze({ ...capability.lifecycle }) }
      : {}),
  });
}

export function compileAgentRegistry(params: {
  toolkits: readonly AgentToolkit[];
  capabilities: readonly AgentCapability[];
}): CompiledAgentRegistry {
  const toolkitDefinitions = [...params.toolkits];
  const rawCapabilityDefinitions = [...params.capabilities];
  validateUniqueToolkitNames(toolkitDefinitions);
  validateUniqueCapabilityNames(rawCapabilityDefinitions);

  const toolkits = toolkitDefinitions.map(snapshotToolkit);
  const capabilityDefinitions = rawCapabilityDefinitions.map(snapshotCapability);
  const toolkitsByName = new Map(toolkits.map((toolkit) => [toolkit.name, toolkit]));

  const capabilities: CompiledCapability[] = [];
  const unavailableCapabilities: UnavailableCapability[] = [];
  for (const capability of capabilityDefinitions) {
    const result = compileExecutor(capability.uses, toolkitsByName);
    if (!result.executor) {
      unavailableCapabilities.push(Object.freeze({
        capability,
        issues: Object.freeze(result.issues),
      }));
      continue;
    }
    capabilities.push(Object.freeze({
      capability,
      ...result.executor,
    }));
  }

  return Object.freeze({
    toolkits: Object.freeze(toolkits),
    capabilities: Object.freeze(capabilities),
    unavailableCapabilities: Object.freeze(unavailableCapabilities),
  });
}
