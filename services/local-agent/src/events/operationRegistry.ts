import type {
  AgentToolkit,
  ToolOperationMetadata,
  ToolOperationSummary,
} from '@pinpawo/pet-agent';

export type OperationSummary = ToolOperationSummary;
export type OperationMetadata = ToolOperationMetadata;

export type RegisteredOperationMetadata = OperationMetadata & {
  source: {
    provider: 'toolkit' | 'toolset';
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
    for (const [toolName, metadata] of Object.entries(toolkit.operations ?? {})) {
      entries[toolName] = {
        ...metadata,
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
