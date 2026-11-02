import { isJsonObject } from './json';

/** A reference a tool declares as part of the current delivery. */
export type Deliverable = {
  uri: string;
  title?: string;
};

/** The delivery declaration carried in a ToolMessage's artifact. */
export type ToolDeliverables = {
  deliverables: Deliverable[];
};

/**
 * Validate a tool's artifact before returning it. Other artifact metadata is
 * allowed, as are fields beyond uri and title on individual deliverables.
 */
export function assertToolDeliverables(value: unknown): asserts value is ToolDeliverables {
  if (!isJsonObject(value) || !Array.isArray(value.deliverables)) {
    throw new TypeError('Tool artifact deliverables must be an array.');
  }
  for (const [index, deliverable] of value.deliverables.entries()) {
    if (!isJsonObject(deliverable)
      || typeof deliverable.uri !== 'string' || !deliverable.uri.trim()
      || (deliverable.title !== undefined && typeof deliverable.title !== 'string')) {
      throw new TypeError(`Invalid tool deliverable at index ${index}: expected { uri: non-empty string, title?: string }.`);
    }
  }
}

/** Construct and validate a delivery declaration for a tool result. */
export function createToolDeliverables(deliverables: unknown): ToolDeliverables {
  const artifact = { deliverables };
  assertToolDeliverables(artifact);
  return artifact;
}
