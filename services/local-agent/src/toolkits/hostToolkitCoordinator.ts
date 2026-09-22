import {
  buildHostToolkitInventory, HostToolkitInventoryStore, reportUnavailableToolkitAvailability,
  type HostToolkitInventorySnapshot, type ToolkitAvailabilityResolver, type ToolkitDefinitionSource,
} from './toolkitInventory';
import { connectHostRuntimes, type RuntimeClientFactory } from '../runtimeService/hostClient';
import { bindToolkitRuntime, type HostedToolkit, type ToolkitRuntimeClientBinding } from './runtimeBinding';

type RuntimeConnection = {
  bindings: Readonly<Record<string, ToolkitRuntimeClientBinding>>;
  close: () => Promise<void>;
};
export type HostToolkitCoordinatorOptions = Readonly<{
  inventoryStore?: HostToolkitInventoryStore;
  resolveAvailability?: ToolkitAvailabilityResolver;
  warn?: (message: string) => void;
  connectRuntimes?: (options: {
    toolkits: readonly HostedToolkit[];
    clientFactories?: Readonly<Record<string, RuntimeClientFactory>>;
  }) => Promise<RuntimeConnection>;
}>;

/** Host-owned connection and static, fully assembled Tool inventory. */
export class HostToolkitCoordinator {
  private readonly inventoryStore: HostToolkitInventoryStore;
  private readonly options: HostToolkitCoordinatorOptions;
  private connection: RuntimeConnection | undefined;

  constructor(options: HostToolkitCoordinatorOptions = {}) {
    this.options = options;
    this.inventoryStore = options.inventoryStore ?? new HostToolkitInventoryStore();
  }

  async initialize(
    sources: readonly ToolkitDefinitionSource[],
    options: { clientFactories?: Readonly<Record<string, RuntimeClientFactory>> } = {},
  ): Promise<HostToolkitInventorySnapshot> {
    if (this.connection) throw new Error('Host Toolkit clients are already connected.');
    try {
      const snapshot = await buildHostToolkitInventory({
        sources,
        assembleToolkits: async (definitions) => {
          const connect = this.options.connectRuntimes ?? connectHostRuntimes;
          this.connection = await connect({ toolkits: definitions, ...options });
          return definitions.map(toolkit => bindToolkitRuntime(toolkit, this.connection!.bindings[toolkit.name]));
        },
        ...(this.options.resolveAvailability ? { resolveAvailability: this.options.resolveAvailability } : {}),
      });
      this.inventoryStore.replace(snapshot);
      reportUnavailableToolkitAvailability(snapshot, this.options.warn ?? console.warn);
      return snapshot;
    } catch (error) {
      await this.shutdown();
      throw error;
    }
  }

  getInventoryStore(): HostToolkitInventoryStore { return this.inventoryStore; }

  async shutdown(): Promise<void> {
    const connection = this.connection;
    this.connection = undefined;
    await connection?.close();
  }
}
