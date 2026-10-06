import type { StructuredTool } from '@langchain/core/tools';
import type {
  NamedStructuredTool,
  ToolDefinition,
  ToolOperationMetadata,
  ToolReviewPolicy,
} from '@pinpawo/pet-agent';
import { withExecutionWorkdir } from './executionContext';
import { SHELL_RS_REQUIREMENT, type ShellRS } from './shellRS/shellRS';

/** The ShellRS instance the Host selected for a shell-dependent Toolkit. */
export type ShellToolkitDependencies = Readonly<{ shell: ShellRS }>;

/** Shell-dependent Toolkits depend on exactly one ShellRS, under this key. */
export const shellRequirement = Object.freeze({ shell: SHELL_RS_REQUIREMENT });

/** A shell-dependent Toolkit is exactly as available as its ShellRS. */
export function shellAvailability(shell: ShellRS) {
  return async () => await shell.status();
}

/**
 * Tool definitions resolved against the Host's execution workdir, each with
 * its operation metadata and review policy (absent means unreviewed).
 */
export function executionScopedDefinitions(
  tools: readonly StructuredTool[],
  operations: Record<string, ToolOperationMetadata> = {},
  reviews: Record<string, ToolReviewPolicy> = {},
): ToolDefinition[] {
  return tools.map((item) => {
    const scoped = withExecutionWorkdir(item as NamedStructuredTool);
    return { tool: scoped, operation: operations[item.name], review: reviews[item.name] };
  });
}

/** The definitions among `definitions` whose tools are in `tools`, by name. */
export function pickDefinitions(definitions: readonly ToolDefinition[], tools: readonly StructuredTool[]) {
  const names = new Set(tools.map((item) => item.name));
  return definitions.filter((definition) => names.has(definition.tool.name));
}
