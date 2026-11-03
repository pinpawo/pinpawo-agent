/** A tool-declared reference, independent of its storage or display transport. */
export type Deliverable = { uri: string; title?: string };
export type ToolDeliverables = { deliverables: Deliverable[] };

export function assertToolDeliverables(value: unknown): asserts value is ToolDeliverables {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || !('deliverables' in value) || !Array.isArray(value.deliverables)) {
    throw new TypeError('Tool deliverables must contain a deliverables array.');
  }
  for (const reference of value.deliverables) {
    if (!reference || typeof reference !== 'object' || Array.isArray(reference)
      || typeof reference.uri !== 'string' || !reference.uri.trim()
      || (reference.title !== undefined && typeof reference.title !== 'string')) {
      throw new TypeError('Each deliverable requires a nonempty uri and an optional string title.');
    }
  }
}

export function createToolDeliverables(deliverables: readonly Deliverable[]): ToolDeliverables {
  const value = { deliverables: [...deliverables] };
  assertToolDeliverables(value);
  return value;
}

export function readToolDeliverables(artifact: unknown): Deliverable[] {
  if (!artifact || typeof artifact !== 'object' || !Object.hasOwn(artifact, 'deliverables')) return [];
  assertToolDeliverables(artifact);
  return artifact.deliverables;
}
