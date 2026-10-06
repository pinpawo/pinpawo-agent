/**
 * #643: Shared Host capability assembly.
 *
 * toolkit / capability / model / checkpointer —— the things needed to build
 * a working pet. Both Chat Host and Studio Host need them; they don't belong
 * to either host exclusively.
 *
 * This class is the "capability supply" that issue #643 identifies as
 * "buried in host with no name". It is NOT a domain concept — it is a
 * construction helper. Per design §6.7, construction helpers must not
 * reverse-define domain models.
 */
import {
  type AgentToolkit,
  type CapabilityArtifactStore,
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
} from './config/llmConfig';
import { startupStoredConfig } from './storage';
import {
  createHostBaselineCapabilities,
} from './hostCapabilityCatalog';
import { HostCapabilityCatalog } from './hostCapabilityCatalog';
import {
  findLegacyHostState,
  type HostRuntimeConfig,
} from './config/runtimeConfig';
import { resolveHostExecutionConfig, type HostExecutionConfig } from './config/hostExecutionConfig';
import { loadAgentContext } from './contextLoader';
import { createFilesToolkit } from './toolkits/files';
import { createGitToolkit } from './toolkits/git';
import { createGithubToolkit } from './toolkits/github';
import { createProjectInspectionToolkit } from './toolkits/projectInspection';
import { createShellToolkit } from './toolkits/shell';
import { ShellRSClient } from './toolkits/shellRS';
import { createWebToolkit } from './toolkits/web';
import { BrowserRSClient } from './toolkits/browserRSClient';
import { HostToolkitCoordinator } from './toolkits/hostToolkitCoordinator';
import {
  HostRSInstances,
  type HostRSStatus,
} from './toolkits/hostRS';
import type {
  HostToolkitInventoryStore,
  ToolkitDefinitionSource,
} from './toolkits/toolkitInventory';
import { FileSaver } from './fileSaver';

export type HostCapabilityAssemblyOptions = {
  runtimeConfig: HostRuntimeConfig;
  /** Distinguishes plugin toolkit source label for diagnostics. */
  sourceId: string;
  /** Host-owned checkpoint root. Independent hosts must not share a writer root. */
  checkpointPath?: string;
  /** Chat loads the global user registry; per-Pet hosts may own stricter sources. */
  loadUserCapabilities?: boolean;
  /**
   * Whether this Host offers the Browser Toolkit (through its client of the
   * RS service's BrowserRS). Chat keeps the user-selected default; a Studio
   * must opt in explicitly.
   */
  includeBrowser?: boolean;
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
  private readonly runtimeConfig: HostRuntimeConfig;
  private readonly executionConfig: HostExecutionConfig;
  private readonly sourceId: string;
  private modelProfiles: LocalModelProfileRegistry | null = null;
  private readonly toolkitCoordinator = new HostToolkitCoordinator();
  /** In-process RS instances this Host created and injects into Toolkits. */
  private readonly rsInstances = new HostRSInstances();
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
    this.executionConfig = resolveHostExecutionConfig(options.runtimeConfig);
    this.sourceId = options.sourceId;
    const browserSelected = options.includeBrowser
      ?? startupStoredConfig.capabilities?.browser !== false;
    // ShellRS runs only in the standalone RS service (#853); the Host reaches
    // it through one client. Shell, git, github and project-inspection share
    // that client, and so one logical session per Agent session across them.
    // Files and web run in the Host process and need no RS.
    const shell = this.rsInstances.add('shell', new ShellRSClient());
    // BrowserRS also runs only in the RS service, which holds the one
    // extension bridge for every Host (#862).
    const browser = browserSelected
      ? this.rsInstances.add('browser', new BrowserRSClient())
      : null;
    this.hostBuiltInToolkits = [
      createFilesToolkit(),
      createWebToolkit(),
      this.rsInstances.assemble(createShellToolkit, { shell }),
      this.rsInstances.assemble(createGitToolkit, { shell }),
      this.rsInstances.assemble(createGithubToolkit, { shell }),
      this.rsInstances.assemble(createProjectInspectionToolkit, { shell }),
      createCapabilityCreatorToolkit(),
      ...(browser
        ? [this.rsInstances.assemble(createBrowserToolkit, { browser })]
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
      const legacyStatePaths = findLegacyHostState(this.runtimeConfig);
      if (legacyStatePaths.length > 0) {
        console.warn(
          `[${this.sourceId}] Capability V2 uses a new conversation checkpoint namespace. `
          + `Legacy state is preserved but not loaded: ${legacyStatePaths.join(', ')}`,
        );
      }
    }
    const { toolkitSources } = await loadPlugins();
    this.modelProfiles = buildLocalModelProfileRegistry();
    // Validate Capability sources before starting any RS instance. A
    // configured name collision must fail without acquiring dynamic resources.
    await this.capabilityCatalog.load();
    // RS start failures stay in each instance's status, which the inventory
    // then reads as the availability of the Toolkits built on it. A failed
    // instance keeps retrying; once it starts, its Toolkits are re-evaluated
    // so later executions get them back.
    await this.rsInstances.start({
      warn: (message) => console.warn(`[${this.sourceId}] ${message}`),
      onRecovered: async (toolkitNames) => {
        const inventory = this.toolkitCoordinator.getInventoryStore();
        for (const name of toolkitNames) await inventory.refresh(name);
      },
    });
    await this.toolkitCoordinator.initialize([
      ...toolkitSources,
      ...options.toolkitSources,
      {
        id: this.sourceId,
        kind: 'host_builtin',
        definitions: this.hostBuiltInToolkits,
      },
    ]);
  }

  getExecutionConfig(): HostExecutionConfig {
    return this.executionConfig;
  }

  getRuntimeConfig(): HostRuntimeConfig {
    return this.runtimeConfig;
  }

  getCheckpointer(): FileSaver {
    return this.checkpointer;
  }

  /** Chat compatibility name; shared consumers should use getCheckpointer(). */
  getChatCheckpointer(): FileSaver {
    return this.getCheckpointer();
  }

  /** Availability of each RS instance this Host created. */
  getRSStatus(): Promise<readonly HostRSStatus[]> {
    return this.rsInstances.status();
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

  async shutdown(): Promise<void> {
    try {
      await this.rsInstances.dispose();
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
