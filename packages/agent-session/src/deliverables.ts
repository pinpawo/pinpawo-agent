import { assertToolDeliverables, type Deliverable } from '@pinpawo/agent-contracts';

/** Parse an optional public reference list without inferring links from prose. */
export function parseDeliverables(value: unknown): Deliverable[] | undefined {
  try {
    const artifact = { deliverables: value };
    assertToolDeliverables(artifact);
    return artifact.deliverables.map(({ uri, title }) => ({ uri, ...(title !== undefined ? { title } : {}) }));
  } catch {
    return undefined;
  }
}
