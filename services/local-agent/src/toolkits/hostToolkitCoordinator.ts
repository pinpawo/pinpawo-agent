import {
  ToolkitRuntimeManager,
  type ToolkitRuntimeDiagnostic,
} from '@pinpawo/pet-agent';
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
  runtimeManager?: ToolkitRuntimeManager;
  resolveAvailability?: ToolkitAvailabilityResolver;
  warn?: (message: string) => void;
}>;

/**
 * Local Host owner of Toolkit definitions, availability projections, Runtime
 * roots, and their generic diagnostics. Toolkit-specific behavior stays in
 * each definition and never enters this coordinator.
 */
export class HostToolkitCoordinator {
  private readonly inventoryStore: HostToolkitInventoryStore;
  private readonly runtimeManager: ToolkitRuntimeManager;
  private readonly resolveAvailability: ToolkitAvailabilityResolver | undefined;
  private readonly warn: (message: string) => void;

  constructor(options: HostToolkitCoordinatorOptions = {}) {
    this.inventoryStore = options.inventoryStore ?? new HostToolkitInventoryStore();
    this.runtimeManager = options.runtimeManager ?? new ToolkitRuntimeManager();
    this.resolveAvailability = options.resolveAvailability;
    this.warn = options.warn ?? console.warn;
  }

  async initialize(
    sources: readonly ToolkitDefinitionSource[],
  ): Promise<HostToolkitInventorySnapshot> {
    const snapshot = await buildHostToolkitInventory({
      sources,
      startToolkitRuntimes: async (definitions) => {
        await this.runtimeManager.start(definitions);
      },
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

  getRuntimeManager(): ToolkitRuntimeManager {
    return this.runtimeManager;
  }

  diagnose(): Promise<readonly ToolkitRuntimeDiagnostic[]> {
    return this.runtimeManager.diagnose();
  }

  shutdown(): Promise<void> {
    return this.runtimeManager.stop();
  }
}
