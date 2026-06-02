import type {
  AgentToolkit,
  ToolkitOperationMetadata,
  ToolkitOperationSummary,
} from '@pinpawo/pet-agent';

export type OperationSummary = ToolkitOperationSummary;
export type OperationMetadata = ToolkitOperationMetadata;

export type RegisteredOperationMetadata = OperationMetadata & {
  source: {
    provider: 'toolkit' | 'capability' | 'runtime';
    name: string;
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
  runtimeOperations?: Record<string, ToolkitOperationMetadata>;
}): OperationRegistry {
  const entries: Record<string, RegisteredOperationMetadata> = {};

  for (const toolkit of params.toolkits) {
    for (const [toolName, metadata] of Object.entries(toolkit.operations ?? {})) {
      entries[toolName] = {
        ...metadata,
        source: {
          provider: 'toolkit',
          name: toolName,
        },
      };
    }
  }

  for (const [toolName, metadata] of Object.entries(params.runtimeOperations ?? {})) {
    entries[toolName] = {
      ...metadata,
      source: {
        provider: 'runtime',
        name: toolName,
      },
    };
  }

  return createOperationRegistry(entries);
}

export const emptyOperationRegistry = createOperationRegistry();
