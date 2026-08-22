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
import {
  GENERAL_CAPABILITY_NAME,
  type AgentCapability,
  type CapabilityArtifactStore,
  type ToolkitRuntimeDiagnostic,
  type ToolkitRuntimeManager,
} from '@pinpawo/pet-agent';
import {
  buildLocalAgentRuntimeConfig,
  FileSaver,
  HostCapabilityAssembly,
  loadCapabilityDirectory,
  resolveHostCheckpointPath,
  type HostToolkitInventoryStore,
  type LocalAgentRuntimeConfig,
  type LocalModelProfileRegistry,
  type ToolkitDefinitionSource,
} from 'pinpawo/host-runtime';
import {
  buildStudio,
  resolveStudioHostConfig,
  type BuildStudioResult,
  type StudioPluginResolver,
} from './buildStudio';
import type { Studio } from '../studioContract';
import { resolvePetCapabilityDirectory } from './petConfig';

export type StudioHostOptions = {
  runtimeConfig?: LocalAgentRuntimeConfig;
  resolvePlugin?: StudioPluginResolver;
  /** Composition hook for lifecycle tests and embedded hosts. */
  capabilityAssembly?: HostCapabilityAssembly;
  /** Composition hook for deterministic configuration tests. */
  resolveStudioHostConfig?: typeof resolveStudioHostConfig;
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
  private readonly resolveStudioHostConfigImpl: typeof resolveStudioHostConfig;
  private readonly resolvePlugin: StudioPluginResolver | undefined;
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
      loadUserCapabilities: false,
    });
    this.buildStudioImpl = options.buildStudio ?? buildStudio;
    this.resolveStudioHostConfigImpl = options.resolveStudioHostConfig ?? resolveStudioHostConfig;
    this.resolvePlugin = options.resolvePlugin;
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
      // Establish exclusive Host ownership before resolving Plugins or loading
      // Capability entry modules. A competing Host must fail before any
      // extension code can execute.
      this.caps.acquireWriterLease();
      this.capsInitialized = true;
      const runtimeConfig = this.caps.getRuntimeConfig();
      const configuration = await this.resolveStudioHostConfigImpl({
        workdir: runtimeConfig.workdir,
        ...(runtimeConfig.studioConfigPath
          ? { studioConfigPath: runtimeConfig.studioConfigPath }
          : {}),
        ...(runtimeConfig.petsDir ? { petsDir: runtimeConfig.petsDir } : {}),
        ...(this.resolvePlugin ? { resolvePlugin: this.resolvePlugin } : {}),
      });
      const pluginToolkitSources: ToolkitDefinitionSource[] = configuration.plugins.map(
        (plugin) => ({
          id: `studio-plugin:${plugin.name}`,
          kind: 'plugin',
          definitions: plugin.toolkits,
        }),
      );
      const petCapabilities = new Map<string, AgentCapability[]>();
      for (const pet of configuration.resolved.pets) {
        const capabilityDir = resolvePetCapabilityDirectory(configuration.petsDir, pet.petId);
        const loaded = await loadCapabilityDirectory(capabilityDir);
        petCapabilities.set(pet.petId, loaded.map(({ capability }) => capability));
      }

      await this.caps.init({
        toolkitSources: pluginToolkitSources,
      });
      // Build the resident Studio now — before any transport starts listening.
      // Requests only dispatch to this pre-built instance.
      this.studio = await this.buildStudioImpl({
        configuration,
        modelProfiles: this.caps.getModelProfiles(),
        hostCapabilities: this.caps.getLocalCapabilities().filter(
          ({ name }) => name === GENERAL_CAPABILITY_NAME,
        ),
        petCapabilities,
        toolkits: [...this.caps.getToolkitInventoryStore().getSnapshot().effectiveToolkits],
        toolkitRuntimeManager: this.caps.getToolkitRuntimeManager(),
        checkpoint: this.getCheckpointer(),
        ownerUserId: null,
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

  getActorId(): string {
    return this.caps.getActorId();
  }

  getActorName(): string | null {
    return this.caps.getActorName();
  }

}
