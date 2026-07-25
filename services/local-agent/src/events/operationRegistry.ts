import type {
  AgentToolkit,
  SubagentToolOperationMetadata,
  ToolOperationMetadata,
  ToolOperationSummary,
} from '@pinpawo/pet-agent';

export type OperationSummary = ToolOperationSummary;
export type OperationMetadata = ToolOperationMetadata;

export type RegisteredOperationMetadata = OperationMetadata & {
  source: {
    provider: 'toolkit';
    name: string;
    toolName: string;
  };
};

export type OperationRegistry = {
  resolveToolOperation(toolName: string): RegisteredOperationMetadata | null;
};

export function createOperationRegistry(
  entries: Record<string, RegisteredOperationMetadata> = {},
): OperationRegistry {
  const operations = new Map(Object.entries(entries));
  return {
    resolveToolOperation(toolName: string) {
      return operations.get(toolName) ?? null;
    },
  };
}

export function createOperationRegistryFromToolkits(
  toolkits: AgentToolkit[],
): OperationRegistry {
  return createOperationRegistryFromSources({ toolkits });
}

export function createOperationRegistryFromSources(params: {
  toolkits: AgentToolkit[];
}): OperationRegistry {
  const entries: Record<string, RegisteredOperationMetadata> = {};

  for (const toolkit of params.toolkits) {
    for (const definition of toolkit.tools) {
      if (!definition.operation) {
        continue;
      }
      const toolName = definition.tool.name;
      entries[toolName] = {
        ...definition.operation,
        source: {
          provider: 'toolkit',
          name: toolkit.name,
          toolName,
        },
      };
    }
  }

  return createOperationRegistry(entries);
}

export const emptyOperationRegistry = createOperationRegistry();

/**
 * Overlay per-delegation operation metadata (a `subagent_operations`
 * announcement, #322 Phase 4) on a base registry. Overlay entries win over the
 * base for the tools they name.
 */
export function overlayOperationRegistry(
  base: OperationRegistry,
  entries: Record<string, SubagentToolOperationMetadata>,
): OperationRegistry {
  const overlay = new Map(Object.entries(entries).map(([toolName, metadata]) => {
    return [
      toolName,
      {
        ...metadata,
        source: {
          provider: 'toolkit' as const,
          name: metadata.source?.name ?? 'delegation',
          toolName: metadata.source?.toolName ?? toolName,
        },
      } satisfies RegisteredOperationMetadata,
    ];
  }));
  return {
    resolveToolOperation(toolName: string) {
      return overlay.get(toolName) ?? base.resolveToolOperation(toolName);
    },
  };
}
