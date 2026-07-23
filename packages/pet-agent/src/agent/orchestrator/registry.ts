import type { StructuredTool } from '@langchain/core/tools';
import type { AgentCapability } from '../../types/capability';
import type { AgentToolkit } from '../../types/toolkit';
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

export type CompiledExecutor = {
  toolkits: readonly AgentToolkit[];
  tools: readonly StructuredTool[];
  toolNames: readonly string[];
};

export type CompiledCapability = CompiledExecutor & {
  capability: AgentCapability;
};

export type UnavailableCapability = {
  capability: AgentCapability;
  issues: readonly ExecutorCompilationIssue[];
};

export type CompiledAgentRegistry = {
  toolkits: readonly AgentToolkit[];
  general: CompiledExecutor;
  capabilities: readonly CompiledCapability[];
  unavailableCapabilities: readonly UnavailableCapability[];
};

export class ExecutorCompilationError extends Error {
  readonly issues: readonly ExecutorCompilationIssue[];

  constructor(owner: string, issues: readonly ExecutorCompilationIssue[]) {
    super(`${owner} Toolkit dependencies are invalid: ${formatExecutorCompilationIssues(issues)}`);
    this.name = 'ExecutorCompilationError';
    this.issues = issues;
  }
}

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
): { executor: CompiledExecutor | null; issues: ExecutorCompilationIssue[] } {
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
      toolkits: selectedToolkits,
      tools,
      toolNames: tools.map((tool) => tool.name),
    },
    issues,
  };
}

export function compileAgentRegistry(params: {
  toolkits: readonly AgentToolkit[];
  capabilities: readonly AgentCapability[];
  generalUses: readonly string[];
}): CompiledAgentRegistry {
  const toolkits = [...params.toolkits];
  const capabilityDefinitions = [...params.capabilities];
  validateUniqueToolkitNames(toolkits);
  validateUniqueCapabilityNames(capabilityDefinitions);

  const toolkitsByName = new Map(toolkits.map((toolkit) => [toolkit.name, toolkit]));
  const generalResult = compileExecutor(params.generalUses, toolkitsByName);
  if (!generalResult.executor) {
    throw new ExecutorCompilationError('General executor', generalResult.issues);
  }

  const capabilities: CompiledCapability[] = [];
  const unavailableCapabilities: UnavailableCapability[] = [];
  for (const capability of capabilityDefinitions) {
    const result = compileExecutor(capability.uses, toolkitsByName);
    if (!result.executor) {
      const hasContractError = result.issues.some(
        (issue) => issue.code !== 'unknown_toolkit',
      );
      if (hasContractError) {
        throw new ExecutorCompilationError(
          `Capability "${capability.name}"`,
          result.issues,
        );
      }
      unavailableCapabilities.push({
        capability,
        issues: result.issues,
      });
      continue;
    }
    capabilities.push({
      capability,
      ...result.executor,
    });
  }

  return {
    toolkits,
    general: generalResult.executor,
    capabilities,
    unavailableCapabilities,
  };
}
