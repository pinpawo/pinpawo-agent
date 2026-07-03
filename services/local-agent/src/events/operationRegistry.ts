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

/**
 * Overlay per-delegation operation metadata (a `subagent_operations`
 * announcement, #322 Phase 4) on a base registry. Delegation-scoped toolset
 * operations are not in any statically known toolkit, so the announcement is
 * the only way their display metadata reaches the operation join. Overlay
 * entries win over the base for the tools they name.
 */
export function overlayOperationRegistry(
  base: OperationRegistry,
  entries: Record<string, SubagentToolOperationMetadata>,
): OperationRegistry {
  const overlay = new Map(Object.entries(entries).map(([toolName, metadata]) => {
    const provider = metadata.source?.provider;
    return [
      toolName,
      {
        ...metadata,
        source: {
          provider: provider === 'toolkit' ? 'toolkit' as const : 'toolset' as const,
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
