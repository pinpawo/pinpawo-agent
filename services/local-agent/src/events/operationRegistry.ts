export type OperationSummary = {
  target?: string;
  summary?: string;
  details?: Record<string, unknown>;
};

export type OperationMetadata = {
  kind: string;
  title?: string;
  titleKey?: string;
  summarizeInput?: (input: unknown) => OperationSummary | null;
  summarizeOutput?: (output: unknown) => OperationSummary | null;
  summarizeError?: (error: unknown) => OperationSummary | null;
};

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

export const emptyOperationRegistry = createOperationRegistry();
