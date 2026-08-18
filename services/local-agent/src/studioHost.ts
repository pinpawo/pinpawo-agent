/**
 * #643: Studio Host — independent entry point for Studio mode.
 *
 * Studio is no longer a branch of the Chat Host. It has its own entry,
 * its own transport, and its own lifecycle. It shares capability supply
 * (toolkit / capability / model / checkpointer) with Chat Host via
 * {@link HostCapabilityAssembly}, but does NOT carry chat-only concerns
 * (ws relay, TUI session, chat handler).
 *
 * Studio-specific fields like `globalReviewPolicyMode` and
 * `autoAuthorizationSafetyLevel` are provided by `run.ts` when building
 * `LocalServerDeps`, not held here — Studio has no chat surface to
 * configure them.
 */
import type {
  CapabilityArtifactStore,
  ToolkitRuntimeDiagnostic,
  ToolkitRuntimeManager,
} from '@pinpawo/pet-agent';
import type { LoadedUserCapability } from './capabilityLoader';
import {
  type LocalModelProfileRegistry,
} from './llmConfig';
import { HostCapabilityAssembly } from './hostCapabilityAssembly';
import {
  buildLocalAgentRuntimeConfig,
  type LocalAgentRuntimeConfig,
} from './runtimeConfig';
import type { LocalServerDeps, LocalServerStudioModeInfo } from './localServerTypes';
import { getConfig } from './config';
import type { HostToolkitInventoryStore } from './toolkits/toolkitInventory';
import { FileSaver } from './fileSaver';

export type StudioHostOptions = {
  runtimeConfig?: LocalAgentRuntimeConfig;
  studioMode?: LocalServerStudioModeInfo;
};

/**
 * Studio Host.
 *
 * It delegates all capability supply to {@link HostCapabilityAssembly} and
 * only adds Studio-specific concerns: studio mode info and a no-op stop
 * marker (no ws relay loop).
 */
export class StudioHost {
  private readonly caps: HostCapabilityAssembly;
  private readonly studioModeInfo: LocalServerStudioModeInfo | undefined;

  constructor(options: StudioHostOptions = {}) {
    this.caps = new HostCapabilityAssembly({
      runtimeConfig: options.runtimeConfig ?? buildLocalAgentRuntimeConfig(),
      sourceId: 'studio-host',
    });
    this.studioModeInfo = options.studioMode;
  }

  async init() {
    await this.caps.init();
  }

  requestStop() {
    // Studio host does not own a ws relay loop; just a marker.
  }

  async shutdown() {
    this.requestStop();
    await this.caps.shutdown();
  }

  // ---- Capability supply delegation ----

  getRuntimeConfig(): LocalAgentRuntimeConfig {
    return this.caps.getRuntimeConfig();
  }

  getChatCheckpointer(): FileSaver {
    return this.caps.getChatCheckpointer();
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

  getStudioModeInfo(): LocalServerStudioModeInfo | undefined {
    return this.studioModeInfo;
  }

  /**
   * Build `LocalServerDeps` for the transport layer.
   *
   * Chat-only fields (`globalReviewPolicyMode`,
   * `autoAuthorizationSafetyLevel`) are included because `LocalServerDeps`
   * is a shared type; the transport layer needs them even in studio mode
   * for the local server's deps store. They come from host config, not
   * from Studio-specific state.
   */
  buildLocalServerDeps(): LocalServerDeps {
    return {
      serverMode: 'studio',
      ...(this.studioModeInfo ? { studioMode: this.studioModeInfo } : {}),
      actorId: this.getActorId(),
      actorName: this.getActorName() ?? undefined,
      chatCheckpointer: this.getChatCheckpointer(),
      modelProfiles: this.getModelProfiles(),
      globalReviewPolicyMode: getConfig().globalReviewPolicyMode,
      autoAuthorizationSafetyLevel: getConfig().autoAuthorizationSafetyLevel,
      workdir: this.getRuntimeConfig().workdir,
      runtimeConfig: this.getRuntimeConfig(),
      toolkitInventory: this.getToolkitInventoryStore(),
      toolkitRuntimeManager: this.getToolkitRuntimeManager(),
      localCapabilities: this.getLocalCapabilities(),
      userCapabilities: this.getUserCapabilities(),
      capabilityArtifactStore: this.getCapabilityArtifactStore(),
      rescanUserCapabilities: () => this.rescanUserCapabilities(),
    };
  }
}
