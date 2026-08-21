/**
 * #643: Studio Host — independent Studio package entry point.
 *
 * Studio is no longer a branch of the Chat Host. It has its own entry,
 * its own transport, and its own lifecycle. It shares capability supply
 * (toolkit / capability / model / checkpointer construction) with Chat Host via
 * {@link HostCapabilityAssembly}, but does NOT carry chat-only concerns
 * (ws relay, TUI session, chat handler).
 *
 * Chat session/review transport state is intentionally absent.
 */
import type {
  CapabilityArtifactStore,
  ToolkitRuntimeDiagnostic,
  ToolkitRuntimeManager,
} from '@pinpawo/pet-agent';
import {
  buildLocalAgentRuntimeConfig,
  FileSaver,
  HostCapabilityAssembly,
  resolveHostCheckpointPath,
  type HostToolkitInventoryStore,
  type LoadedUserCapability,
  type LocalAgentRuntimeConfig,
  type LocalModelProfileRegistry,
} from 'pinpawo/host-runtime';
import {
  buildStudio,
  type BuildStudioResult,
  type StudioModuleResolver,
} from './buildStudio';
import type { Studio } from '../studioContract';

export type StudioHostOptions = {
  runtimeConfig?: LocalAgentRuntimeConfig;
  resolveModule?: StudioModuleResolver;
  /** Composition hook for lifecycle tests and embedded hosts. */
  capabilityAssembly?: HostCapabilityAssembly;
  /** Composition hook for deterministic resident-Studio construction. */
  buildStudio?: typeof buildStudio;
};

/**
 * Studio Host.
 *
 * It delegates all capability supply to {@link HostCapabilityAssembly} and
 * only adds Studio-specific concerns: a resident Studio built at init time
 * and its lifecycle (without a Chat ws relay loop).
 *
 * The Studio is built once during {@link StudioHost.init} — before any
 * transport begins listening. Requests only invoke the resident Studio;
 * they do not trigger assembly. This is the "resident Host" model from
 * #643: "Studio Host 按配置启动多个常驻 pet runtime / graph；请求只
 * invoke。"
 */
export class StudioHost {
  private readonly caps: HostCapabilityAssembly;
  private readonly buildStudioImpl: typeof buildStudio;
  private readonly resolveModule: StudioModuleResolver | undefined;
  private studio: BuildStudioResult | null = null;
  private capsInitialized = false;
  private initPromise: Promise<void> | null = null;
  private shutdownPromise: Promise<void> | null = null;
  private shutdownRequested = false;

  constructor(options: StudioHostOptions = {}) {
    const runtimeConfig = options.runtimeConfig ?? buildLocalAgentRuntimeConfig();
    this.caps = options.capabilityAssembly ?? new HostCapabilityAssembly({
      runtimeConfig,
      sourceId: 'studio-host',
      checkpointPath: resolveHostCheckpointPath(runtimeConfig, 'studio'),
    });
    this.buildStudioImpl = options.buildStudio ?? buildStudio;
    this.resolveModule = options.resolveModule;
  }

  async init() {
    if (this.studio) return;
    if (this.shutdownRequested) {
      throw new Error('StudioHost.init() called after shutdown started');
    }
    if (this.initPromise) return this.initPromise;
    const pending = this.initialize();
    this.initPromise = pending;
    try {
      await pending;
    } finally {
      if (this.initPromise === pending) this.initPromise = null;
    }
  }

  private async initialize() {
    try {
      // Mark ownership before awaiting init so a partially initialized
      // Capability/Toolkit assembly is still rolled back if init rejects.
      this.capsInitialized = true;
      await this.caps.init();
      // Build the resident Studio now — before any transport starts listening.
      // Requests only dispatch to this pre-built instance.
      const runtimeConfig = this.caps.getRuntimeConfig();
      this.studio = await this.buildStudioImpl({
        modelProfiles: this.caps.getModelProfiles(),
        capabilities: [
          ...this.caps.getLocalCapabilities(),
          ...this.caps.getUserCapabilities().map((item) => item.capability),
        ],
        toolkits: [...this.caps.getToolkitInventoryStore().getSnapshot().effectiveToolkits],
        toolkitRuntimeManager: this.caps.getToolkitRuntimeManager(),
        checkpoint: this.getCheckpointer(),
        ownerUserId: null,
        workdir: runtimeConfig.workdir,
        ...(runtimeConfig.studioConfigPath ? { studioConfigPath: runtimeConfig.studioConfigPath } : {}),
        ...(runtimeConfig.petsDir ? { petsDir: runtimeConfig.petsDir } : {}),
        ...(this.resolveModule ? { resolveModule: this.resolveModule } : {}),
      });
    } catch (error) {
      if (this.capsInitialized) {
        this.capsInitialized = false;
        await this.caps.shutdown().catch((rollbackError) => {
          console.error(
            '[studio-host] capability assembly rollback failed:',
            rollbackError instanceof Error ? rollbackError.message : rollbackError,
          );
        });
      }
      throw error;
    }
  }

  async shutdown() {
    if (this.shutdownPromise) return this.shutdownPromise;
    this.shutdownRequested = true;
    const pending = this.performShutdown();
    this.shutdownPromise = pending;
    return pending;
  }

  private async performShutdown() {
    // If shutdown races init, let init either publish the resident Studio or
    // roll its partial capability assembly back before teardown continues.
    await this.initPromise?.catch(() => undefined);
    const resident = this.studio;
    this.studio = null;
    await resident?.studio.shutdown().catch((error) => {
      console.error(
        '[studio-host] resident Studio shutdown failed:',
        error instanceof Error ? error.message : error,
      );
    });
    if (this.capsInitialized) {
      this.capsInitialized = false;
      await this.caps.shutdown();
    }
  }

  /**
   * Returns the resident Studio built during {@link StudioHost.init}.
   * Throws if called before init.
   */
  getStudio(): Studio {
    if (!this.studio) {
      throw new Error('StudioHost.getStudio() called before init()');
    }
    return this.studio.studio;
  }

  // ---- Capability supply delegation ----

  getRuntimeConfig(): LocalAgentRuntimeConfig {
    return this.caps.getRuntimeConfig();
  }

  getCheckpointer(): FileSaver {
    return this.caps.getCheckpointer();
  }

  getToolkitRuntimeManager(): ToolkitRuntimeManager {
    return this.caps.getToolkitRuntimeManager();
  }

  getToolkitRuntimeDiagnostics(): Promise<readonly ToolkitRuntimeDiagnostic[]> {
    return this.caps.getToolkitRuntimeDiagnostics();
  }

  getModelProfiles(): LocalModelProfileRegistry {
    return this.caps.getModelProfiles();
  }

  getToolkitInventoryStore(): HostToolkitInventoryStore {
    return this.caps.getToolkitInventoryStore();
  }

  getLocalCapabilities() {
    return this.caps.getLocalCapabilities();
  }

  getCapabilityArtifactStore(): CapabilityArtifactStore {
    return this.caps.getCapabilityArtifactStore();
  }

  getUserCapabilities(): LoadedUserCapability[] {
    return this.caps.getUserCapabilities();
  }

  async rescanUserCapabilities(): Promise<LoadedUserCapability[]> {
    return this.caps.rescanUserCapabilities();
  }

  getActorId(): string {
    return this.caps.getActorId();
  }

  getActorName(): string | null {
    return this.caps.getActorName();
  }

}
