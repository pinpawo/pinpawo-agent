import type { CapabilityCatalog } from './capabilityCatalog';

const DEFAULT_MAX_DOCUMENT_READ_BYTES = 64 * 1024;

export class SupervisorDocumentError extends Error {
  constructor(readonly code: 'document_not_found' | 'supervisor_discovery_limit_reached', message: string) {
    super(message);
    this.name = 'SupervisorDocumentError';
  }
}

export type RunSupervisorCapabilityDocument = {
  readonly capabilityName: string;
  readonly content: string;
};

/** Per-invocation accounting shared by persisted disclosure and new detail calls. */
export function createSupervisorDocumentReader(catalog: CapabilityCatalog, maxBytes = DEFAULT_MAX_DOCUMENT_READ_BYTES) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
    throw new Error('Supervisor document byte budget must be a positive integer');
  }
  const entries = new Map(catalog.entries.map((entry) => [entry.capabilityName, entry]));
  let consumedBytes = 0;
  let budgetError: SupervisorDocumentError | null = null;
  return {
    assertWithinBudget() {
      if (budgetError) throw budgetError;
    },
    readCapabilities(names: readonly string[], signal?: AbortSignal): RunSupervisorCapabilityDocument[] {
      signal?.throwIfAborted();
      const documents = [...new Set(names)].map((name) => {
        const entry = entries.get(name);
        if (!entry) throw new SupervisorDocumentError('document_not_found', `Capability "${name}" is not in the current catalog.`);
        return { capabilityName: name, content: entry.content };
      });
      const bytes = documents.reduce((sum, document) => sum + Buffer.byteLength(document.content, 'utf8'), 0);
      if (consumedBytes + bytes > maxBytes) {
        budgetError = new SupervisorDocumentError('supervisor_discovery_limit_reached', 'Capability documents exceed the Supervisor document byte budget.');
        throw budgetError;
      }
      consumedBytes += bytes;
      return documents;
    },
  };
}

export type SupervisorDocumentReader = ReturnType<typeof createSupervisorDocumentReader>;
