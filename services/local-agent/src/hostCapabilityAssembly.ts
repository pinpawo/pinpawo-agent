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
  type AgentToolkit,
  type CapabilityArtifactStore,
  type ToolkitRuntimeDiagnostic,
  type ToolkitRuntimeManager,
} from '@pinpawo/pet-agent';
import {
  createBrowserCapability,
  createBrowserToolkit,
} from '@pinpawo-toolkit/browser';
import { FileCapabilityArtifactStore } from './capabilityArtifactStore';
import {
  createCapabilityCreatorCapability,
  createCapabilityCreatorToolkit,
} from './capabilities/capabilityCreator';
import { loadPlugins } from './pluginLoader';
import {
  buildLocalModelProfileRegistry,
  type LocalModelProfileRegistry,
} from './llmConfig';
import { LOCAL_ACTOR_ID, LOCAL_ACTOR_NAME } from './actorSelection';
import { loadStoredConfig, saveStoredConfig } from './storage';
import {
  createHostBaselineCapabilities,
} from './hostCapabilityCatalog';
import { HostCapabilityCatalog } from './hostCapabilityCatalog';
import {
  findLegacyLocalAgentState,
  type LocalAgentRuntimeConfig,
} from './runtimeConfig';
import { getConfig } from './config';
import { loadAgentContext } from './contextLoader';
import { createBashToolkit, createGitToolkit } from './toolkits/local';
import { HostToolkitCoordinator } from './toolkits/hostToolkitCoordinator';
import type {
  HostToolkitInventoryStore,
  ToolkitDefinitionSource,
} from './toolkits/toolkitInventory';
import { FileSaver } from './fileSaver';

export type HostCapabilityAssemblyOptions = {
  runtimeConfig: LocalAgentRuntimeConfig;
  /** Distinguishes plugin toolkit source label for diagnostics. */
  sourceId: string;
  /** Host-owned checkpoint root. Independent hosts must not share a writer root. */
  checkpointPath?: string;
  /** Chat loads the global user registry; per-Pet hosts may own stricter sources. */
  loadUserCapabilities?: boolean;
};

export type HostCapabilityAssemblyInitOptions = {
  /** Additional Toolkit definitions supplied by the concrete Host. */
  toolkitSources?: readonly ToolkitDefinitionSource[];
};

type NormalizedHostCapabilityAssemblyInitOptions = Readonly<{
  toolkitSources: readonly ToolkitDefinitionSource[];
}>;

function normalizeInitOptions(
  options: HostCapabilityAssemblyInitOptions,
): NormalizedHostCapabilityAssemblyInitOptions {
  return Object.freeze({
    toolkitSources: Object.freeze([...(options.toolkitSources ?? [])]),
  });
}

function sameToolkitSource(
  left: ToolkitDefinitionSource,
  right: ToolkitDefinitionSource,
): boolean {
  return left.id === right.id
    && left.kind === right.kind
    && left.definitions.length === right.definitions.length
    && left.definitions.every((definition, index) => definition === right.definitions[index]);
}

function assertInitOptionsCompatible(
  initialized: NormalizedHostCapabilityAssemblyInitOptions,
  requested: NormalizedHostCapabilityAssemblyInitOptions,
): void {
  const missingToolkitSource = requested.toolkitSources.find((source) => (
    !initialized.toolkitSources.some((candidate) => sameToolkitSource(candidate, source))
  ));
  if (!missingToolkitSource) return;

  throw new Error(
    `HostCapabilityAssembly initialization already started without Toolkit source "${missingToolkitSource.id}". `
    + 'All Host extension definitions must be supplied on the first init() call.',
  );
}

export class HostCapabilityAssembly {
  private readonly runtimeConfig: LocalAgentRuntimeConfig;
  private readonly sourceId: string;
  private actorId: string | null = null;
  private actorName: string | null = null;
  private modelProfiles: LocalModelProfileRegistry | null = null;
  private readonly toolkitCoordinator = new HostToolkitCoordinator();
  private readonly hostBuiltInToolkits: readonly AgentToolkit[];
  private readonly capabilityCatalog: HostCapabilityCatalog;
  private readonly capabilityArtifactStore: FileCapabilityArtifactStore;
  private readonly checkpointer: FileSaver;
  private writerLeaseHeld = false;
  private initialized = false;
  private initPromise: Promise<void> | null = null;
  private initOptions: NormalizedHostCapabilityAssemblyInitOptions | null = null;
  private legacyStateNoticeReported = false;

  constructor(options: HostCapabilityAssemblyOptions) {
    this.runtimeConfig = options.runtimeConfig;
    this.sourceId = options.sourceId;
    const browserSelected = loadStoredConfig().capabilities?.browser !== false;
    this.hostBuiltInToolkits = [
      createBashToolkit(),
      createGitToolkit(),
      createCapabilityCreatorToolkit(),
      ...(browserSelected
        ? [createBrowserToolkit({ backend: () => getConfig().browserBackend })]
        : []),
    ];
    this.capabilityCatalog = new HostCapabilityCatalog({
      ...(options.loadUserCapabilities === false
        ? { loadConfiguredCapabilities: async () => [] }
        : {}),
      createHostCapabilities: () => [
        ...createHostBaselineCapabilities(),
        createCapabilityCreatorCapability(),
        ...(browserSelected ? [createBrowserCapability()] : []),
      ],
    });
    this.capabilityArtifactStore = new FileCapabilityArtifactStore(
      this.runtimeConfig.capabilityArtifactRoot,
    );
    this.checkpointer = new FileSaver(
      options.checkpointPath ?? this.runtimeConfig.checkpointPath,
    );
  }

  async init(options: HostCapabilityAssemblyInitOptions = {}) {
    const requestedOptions = normalizeInitOptions(options);
    if (this.initOptions) {
      assertInitOptionsCompatible(this.initOptions, requestedOptions);
    } else {
      this.initOptions = requestedOptions;
    }
    if (this.initialized) return;
    if (this.initPromise) return this.initPromise;
    const pending = this.initializeWithWriterLease(this.initOptions);
    this.initPromise = pending;
    try {
      await pending;
      this.initialized = true;
    } catch (error) {
      this.initOptions = null;
      throw error;
    } finally {
      if (this.initPromise === pending) this.initPromise = null;
    }
  }

  /**
   * Claim this Host's checkpoint root before resolving executable Host
   * extensions. `init()` also calls this method, so Chat callers keep the
   * existing one-step lifecycle while Studio can establish ownership earlier.
   */
  acquireWriterLease(): void {
    if (this.writerLeaseHeld) return;
    this.checkpointer.acquireHostWriterLease(this.sourceId);
    this.writerLeaseHeld = true;
  }

  private async initializeWithWriterLease(options: NormalizedHostCapabilityAssemblyInitOptions) {
    this.acquireWriterLease();
    try {
      await this.checkpointer.runHostStartupMaintenance();
      await this.initialize(options);
    } catch (error) {
      this.writerLeaseHeld = false;
      this.checkpointer.releaseHostWriterLease();
      throw error;
    }
  }

  private async initialize(options: NormalizedHostCapabilityAssemblyInitOptions) {
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
    // Validate Capability sources before starting any Toolkit Runtime roots.
    // A configured name collision must fail without acquiring dynamic
    // resources or leaving a dirty Runtime manager behind.
    await this.capabilityCatalog.load();
    await this.toolkitCoordinator.initialize([
      ...toolkitSources,
      ...options.toolkitSources,
      {
        id: this.sourceId,
        kind: 'host_builtin',
        definitions: this.hostBuiltInToolkits,
      },
    ]);
    this.actorId = LOCAL_ACTOR_ID;
    this.actorName = LOCAL_ACTOR_NAME;
  }

  getRuntimeConfig(): LocalAgentRuntimeConfig {
    return this.runtimeConfig;
  }

  getCheckpointer(): FileSaver {
    return this.checkpointer;
  }

  /** Chat compatibility name; shared consumers should use getCheckpointer(). */
  getChatCheckpointer(): FileSaver {
    return this.getCheckpointer();
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

  getCapabilityCatalog(): HostCapabilityCatalog {
    return this.capabilityCatalog;
  }

  getCapabilityArtifactStore(): CapabilityArtifactStore {
    return this.capabilityArtifactStore;
  }

  async deleteThreadArtifacts(threadId: string): Promise<void> {
    await this.capabilityArtifactStore.deleteThreadArtifacts(threadId);
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
    try {
      await this.toolkitCoordinator.shutdown();
    } finally {
      this.initialized = false;
      this.initOptions = null;
      if (this.writerLeaseHeld) {
        this.writerLeaseHeld = false;
        this.checkpointer.releaseHostWriterLease();
      }
    }
  }
}
