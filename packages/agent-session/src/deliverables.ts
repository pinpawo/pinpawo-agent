import { assertToolDeliverables, type Deliverable } from '@pinpawo/agent-contracts';

/** Read the structured reference list; prose is never interpreted as a declaration. */
export function parseDeliverables(value: unknown): Deliverable[] | undefined {
  try {
    const artifact = { deliverables: value };
    assertToolDeliverables(artifact);
    return artifact.deliverables.map(reference => ({ ...reference }));
  } catch {
    return undefined;
  }
}
