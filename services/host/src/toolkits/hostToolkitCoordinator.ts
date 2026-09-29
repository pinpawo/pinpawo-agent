import {
  buildHostToolkitInventory,
  HostToolkitInventoryStore,
  reportUnavailableToolkitAvailability,
  type HostToolkitInventorySnapshot,
  type ToolkitAvailabilityResolver,
  type ToolkitDefinitionSource,
} from './toolkitInventory';

export type HostToolkitCoordinatorOptions = Readonly<{
  inventoryStore?: HostToolkitInventoryStore;
  resolveAvailability?: ToolkitAvailabilityResolver;
  warn?: (message: string) => void;
}>;

/**
 * Local Host owner of Toolkit definitions and their availability projections.
 * Toolkits arrive already assembled with their RS instances; the RS instances
 * themselves are owned by the Host (see `HostRSInstances`), never by this
 * coordinator or by the Agent framework.
 */
export class HostToolkitCoordinator {
  private readonly inventoryStore: HostToolkitInventoryStore;
  private readonly resolveAvailability: ToolkitAvailabilityResolver | undefined;
  private readonly warn: (message: string) => void;

  constructor(options: HostToolkitCoordinatorOptions = {}) {
    this.inventoryStore = options.inventoryStore ?? new HostToolkitInventoryStore();
    this.resolveAvailability = options.resolveAvailability;
    this.warn = options.warn ?? console.warn;
  }

  async initialize(
    sources: readonly ToolkitDefinitionSource[],
  ): Promise<HostToolkitInventorySnapshot> {
    const snapshot = await buildHostToolkitInventory({
      sources,
      ...(this.resolveAvailability
        ? { resolveAvailability: this.resolveAvailability }
        : {}),
    });
    this.inventoryStore.replace(snapshot);
    reportUnavailableToolkitAvailability(snapshot, this.warn);
    return snapshot;
  }

  getInventoryStore(): HostToolkitInventoryStore {
    return this.inventoryStore;
  }
}
