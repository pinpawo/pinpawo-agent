import {
  ToolkitRuntimeManager,
  type AgentToolkit,
  type ToolkitRuntimeClientBinding,
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
import { connectHostRuntimes, type RuntimeClientFactory } from '../runtimeService/hostClient';

type RuntimeConnection = {
  bindings: Readonly<Record<string, ToolkitRuntimeClientBinding>>;
  close: () => Promise<void>;
};

export type HostToolkitCoordinatorOptions = Readonly<{
  inventoryStore?: HostToolkitInventoryStore;
  runtimeManager?: ToolkitRuntimeManager;
  resolveAvailability?: ToolkitAvailabilityResolver;
  warn?: (message: string) => void;
  connectRuntimes?: (options: {
    toolkits: readonly AgentToolkit[];
    clientFactories?: Readonly<Record<string, RuntimeClientFactory>>;
  }) => Promise<RuntimeConnection>;
}>;

/**
 * Host-owned static definitions and one connection to the Runtime service.
 */
export class HostToolkitCoordinator {
  private readonly inventoryStore: HostToolkitInventoryStore;
  private readonly runtimeManager: ToolkitRuntimeManager;
  private readonly resolveAvailability: ToolkitAvailabilityResolver | undefined;
  private readonly warn: (message: string) => void;
  private readonly connectRuntimes: NonNullable<HostToolkitCoordinatorOptions['connectRuntimes']>;
  private connection: RuntimeConnection | undefined;

  constructor(options: HostToolkitCoordinatorOptions = {}) {
    this.inventoryStore = options.inventoryStore ?? new HostToolkitInventoryStore();
    this.runtimeManager = options.runtimeManager ?? new ToolkitRuntimeManager();
    this.resolveAvailability = options.resolveAvailability;
    this.warn = options.warn ?? console.warn;
    this.connectRuntimes = options.connectRuntimes ?? connectHostRuntimes;
  }

  async initialize(
    sources: readonly ToolkitDefinitionSource[],
    options: { clientFactories?: Readonly<Record<string, RuntimeClientFactory>> } = {},
  ): Promise<HostToolkitInventorySnapshot> {
    if (this.connection) throw new Error('Host Toolkit clients are already connected.');
    try {
      const snapshot = await buildHostToolkitInventory({
        sources,
        connectToolkitRuntimes: async (definitions) => {
          this.connection = await this.connectRuntimes({ toolkits: definitions, ...options });
          this.runtimeManager.replaceBindings(this.connection.bindings);
          this.runtimeManager.select(definitions);
        },
        ...(this.resolveAvailability
          ? { resolveAvailability: this.resolveAvailability }
          : {}),
      });
      this.inventoryStore.replace(snapshot);
      reportUnavailableToolkitAvailability(snapshot, this.warn);
      return snapshot;
    } catch (error) {
      await this.shutdown();
      throw error;
    }
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

  async shutdown(): Promise<void> {
    const connection = this.connection;
    this.connection = undefined;
    this.runtimeManager.replaceBindings({});
    await connection?.close();
  }
}
