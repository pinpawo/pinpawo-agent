/**
 * #643: Shared Host capability assembly.
 *
 * toolkit / capability / model / checkpointer —— the things needed to build
 * a working pet. Both Chat Host and Studio Host need them; they don't belong
 * to either host exclusively.
 *
 * This class is the "capability supply" that issue #643 identifies as
 * "buried in local-agent with no name". It is NOT a domain concept — it is a
 * construction helper. Per design §6.7, construction helpers must not
 * reverse-define domain models.
 */
import {
  type AgentCapability,
  type AgentToolkit,
  type CapabilityArtifactStore,
  type ToolkitRuntimeDiagnostic,
  type ToolkitRuntimeManager,
} from '@pinpawo/pet-agent';
import {
  createBrowserCapability,
  createBrowserToolkit,
} from '@pinpawo-toolkit/browser';
import { loadPlugins } from './pluginLoader';
import type { LoadedUserCapability } from './capabilityLoader';
import {
  buildLocalModelProfileRegistry,
  type LocalModelProfileRegistry,
} from './llmConfig';
import { ensureActorSelected, loadSelectedActorName, LOCAL_ONLY_ACTOR_NAME } from './actorSelection';
import { loadStoredConfig, saveStoredConfig } from './storage';
import {
  createCoreLocalCapabilities,
  LocalAgentCapabilityRegistry,
} from './localAgentCapabilityRegistry';
import {
  findLegacyLocalAgentState,
  type LocalAgentRuntimeConfig,
} from './runtimeConfig';
import { getConfig } from './config';
import { loadAgentContext } from './contextLoader';
import { createBashToolkit, createGitToolkit } from './toolkits/local';
import { HostToolkitCoordinator } from './toolkits/hostToolkitCoordinator';
import type { HostToolkitInventoryStore } from './toolkits/toolkitInventory';
import { FileSaver } from './fileSaver';

export type HostCapabilityAssemblyOptions = {
  runtimeConfig: LocalAgentRuntimeConfig;
  /** Distinguishes plugin toolkit source label for diagnostics. */
  sourceId: string;
};

export class HostCapabilityAssembly {
  private readonly runtimeConfig: LocalAgentRuntimeConfig;
  private readonly sourceId: string;
  private actorId: string | null = null;
  private actorName: string | null = null;
  private modelProfiles: LocalModelProfileRegistry | null = null;
  private readonly toolkitCoordinator = new HostToolkitCoordinator();
  private readonly hostBuiltInToolkits: readonly AgentToolkit[];
  private readonly capabilityRegistry: LocalAgentCapabilityRegistry;
  private readonly chatCheckpointer: FileSaver;
  private legacyStateNoticeReported = false;

  constructor(options: HostCapabilityAssemblyOptions) {
    this.runtimeConfig = options.runtimeConfig;
    this.sourceId = options.sourceId;
    const browserSelected = loadStoredConfig().capabilities?.browser !== false;
    this.hostBuiltInToolkits = [
      createBashToolkit(),
      createGitToolkit(),
      ...(browserSelected
        ? [createBrowserToolkit({ backend: () => getConfig().browserBackend })]
        : []),
    ];
    this.capabilityRegistry = new LocalAgentCapabilityRegistry({
      capabilityArtifactRoot: this.runtimeConfig.capabilityArtifactRoot,
      createDefaultCapabilities: () => [
        ...createCoreLocalCapabilities(),
        ...(browserSelected ? [createBrowserCapability()] : []),
      ],
    });
    this.chatCheckpointer = new FileSaver(this.runtimeConfig.checkpointPath);
  }

  async init() {
    if (!this.legacyStateNoticeReported) {
      this.legacyStateNoticeReported = true;
      const legacyStatePaths = findLegacyLocalAgentState(this.runtimeConfig);
      if (legacyStatePaths.length > 0) {
        console.warn(
          `[${this.sourceId}] Capability V2 uses a new conversation checkpoint namespace. `
          + `Legacy state is preserved but not loaded: ${legacyStatePaths.join(', ')}`,
        );
      }
    }
    const { toolkitSources } = await loadPlugins();
    this.modelProfiles = buildLocalModelProfileRegistry();
    await this.toolkitCoordinator.initialize([
      ...toolkitSources,
      {
        id: this.sourceId,
        kind: 'host_builtin',
        definitions: this.hostBuiltInToolkits,
      },
    ]);
    await this.capabilityRegistry.load();
    this.actorId = await ensureActorSelected({ interactive: false });
    this.actorName = getConfig().apiConnected ? loadSelectedActorName() : LOCAL_ONLY_ACTOR_NAME;
    const ctx = await loadAgentContext(this.actorId);
    if (!this.actorName && ctx.pet.name) {
      this.actorName = ctx.pet.name;
      saveStoredConfig({ ...loadStoredConfig(), actor_name: ctx.pet.name });
    }
  }

  getRuntimeConfig(): LocalAgentRuntimeConfig {
    return this.runtimeConfig;
  }

  getChatCheckpointer(): FileSaver {
    return this.chatCheckpointer;
  }

  getToolkitRuntimeManager(): ToolkitRuntimeManager {
    return this.toolkitCoordinator.getRuntimeManager();
  }

  getToolkitRuntimeDiagnostics(): Promise<readonly ToolkitRuntimeDiagnostic[]> {
    return this.toolkitCoordinator.diagnose();
  }

  getModelProfiles(): LocalModelProfileRegistry {
    return this.modelProfiles ?? buildLocalModelProfileRegistry();
  }

  getToolkitInventoryStore(): HostToolkitInventoryStore {
    return this.toolkitCoordinator.getInventoryStore();
  }

  getLocalCapabilities(): AgentCapability[] {
    return this.capabilityRegistry.getLocalCapabilities();
  }

  getCapabilityArtifactStore(): CapabilityArtifactStore {
    return this.capabilityRegistry.getCapabilityArtifactStore();
  }

  getUserCapabilities(): LoadedUserCapability[] {
    return this.capabilityRegistry.getUserCapabilities();
  }

  async rescanUserCapabilities(): Promise<LoadedUserCapability[]> {
    return this.capabilityRegistry.rescanUserCapabilities();
  }

  getActorId(): string {
    if (!this.actorId) {
      throw new Error(`${this.sourceId} actorId is not initialized`);
    }
    return this.actorId;
  }

  getActorName(): string | null {
    return this.actorName;
  }

  async shutdown(): Promise<void> {
    await this.toolkitCoordinator.shutdown();
  }
}
