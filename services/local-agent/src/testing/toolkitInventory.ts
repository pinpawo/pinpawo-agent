import type { AgentToolkit } from '@pinpawo/pet-agent';
import {
  HostToolkitInventoryStore,
  type HostToolkitInventorySnapshot,
} from '../toolkits/toolkitInventory';

export function createTestHostToolkitInventory(
  definitions: readonly AgentToolkit[] = [],
): HostToolkitInventoryStore {
  const entries = definitions.map((toolkit, definitionIndex) => Object.freeze({
    toolkit,
    provenance: Object.freeze({
      sourceId: 'test-host',
      sourceKind: 'host_builtin' as const,
      sourceIndex: 0,
      definitionIndex,
    }),
    availability: Object.freeze({ available: true as const }),
  }));
  const snapshot: HostToolkitInventorySnapshot = Object.freeze({
    entries: Object.freeze(entries),
    effectiveToolkits: Object.freeze([...definitions]),
  });
  return new HostToolkitInventoryStore(snapshot);
}
