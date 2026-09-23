import {
  buildHostToolkitInventory, HostToolkitInventoryStore, reportUnavailableToolkitAvailability,
  type HostToolkitInventorySnapshot, type ToolkitAvailabilityResolver, type ToolkitDefinitionSource,
} from './toolkitInventory';
import { evaluateToolkitAvailability } from '@pinpawo/pet-agent';
import { connectHostRuntimes, type RuntimeClientFactory } from '../runtimeService/hostClient';
import { RuntimeServiceError } from '../runtimeService/protocol';
import { bindToolkitRuntime, type ToolkitRuntimeRequirement, type ConnectedToolkitRuntime } from './runtimeBinding';

type RuntimeConnection = {
  bindings: Readonly<Record<string, ConnectedToolkitRuntime>>;
  close: () => Promise<void>;
};
export type HostToolkitCoordinatorOptions = Readonly<{
  inventoryStore?: HostToolkitInventoryStore;
  resolveAvailability?: ToolkitAvailabilityResolver;
  warn?: (message: string) => void;
  connectRuntimes?: (options: {
    requirements: readonly ToolkitRuntimeRequirement[];
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
      const unavailableRuntimeToolkits = new Set<string>();
      let runtimeUnavailableReason = '';
      const snapshot = await buildHostToolkitInventory({
        sources,
        assembleToolkits: async (requirements) => {
          const connect = this.options.connectRuntimes ?? connectHostRuntimes;
          try {
            this.connection = await connect({ requirements, ...options });
          } catch (error) {
            const code = (error as { code?: unknown })?.code;
            if (!(error instanceof RuntimeServiceError) && typeof code !== 'string') throw error;
            runtimeUnavailableReason = `Toolkit Runtime Service unavailable (${String(code)}); correct it and restart this Host.`;
            for (const requirement of requirements) {
              if (requirement.runtimeKind) unavailableRuntimeToolkits.add(requirement.toolkit.name);
            }
            return requirements.map(({ toolkit }) => unavailableRuntimeToolkits.has(toolkit.name)
              ? { ...toolkit, availability: () => ({ available: false as const, reason: runtimeUnavailableReason }) }
              : toolkit);
          }
          return requirements.map(requirement => bindToolkitRuntime(
            requirement,
            this.connection!.bindings[requirement.toolkit.name],
          ));
        },
        resolveAvailability: async toolkit => unavailableRuntimeToolkits.has(toolkit.name)
          ? { available: false, reason: runtimeUnavailableReason }
          : (this.options.resolveAvailability ?? evaluateToolkitAvailability)(toolkit),
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
