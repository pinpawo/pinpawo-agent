import { FileSaver } from './fileSaver';
import { getConfig } from './config';
import { HostCapabilityAssembly } from './hostCapabilityAssembly';
import {
  buildLocalAgentRuntimeConfig,
  type LocalAgentRuntimeConfig,
} from './runtimeConfig';
import type { LocalServerDeps } from './localServerTypes';
import { DEFAULT_SERVER_MODE, type ServerMode } from './serverMode';

/**
 * Chat Host — assembles capability supply via {@link HostCapabilityAssembly}
 * and serves the local transport (ws on 127.0.0.1, or stdio).
 *
 * The hosted-app relay and its Hasura-backed context were removed: clients
 * reach this host over the local transport only. Pet identity and context
 * now come from local config, and a future Studio plugin owns any remote
 * surface (#638).
 *
 * Studio is started from its own package and depends only on the exported
 * shared capability-supply surface; this Chat Host never imports it.
 */
export class LocalAgentHost {
  private readonly caps: HostCapabilityAssembly;
  private readonly serverMode: ServerMode;
  private stopRequested = false;
  private readonly stopController = new AbortController();
  constructor(
    runtimeConfig: LocalAgentRuntimeConfig = buildLocalAgentRuntimeConfig(),
    serverMode: ServerMode = DEFAULT_SERVER_MODE,
  ) {
    this.caps = new HostCapabilityAssembly({
      runtimeConfig,
      sourceId: 'local-agent',
    });
    this.serverMode = serverMode;
  }

  async init() {
    await this.caps.init();
  }

  requestStop() {
    this.stopRequested = true;
    this.stopController.abort();
  }

  async shutdown() {
    this.requestStop();
    await this.caps.shutdown();
  }

  // ---- Capability supply delegation ----

  getRuntimeConfig(): LocalAgentRuntimeConfig {
    return this.caps.getRuntimeConfig();
  }

  /** Host 持有的 chat checkpointer;Studio 的 pet 复用同一实例(#613)。 */
  getChatCheckpointer(): FileSaver {
    return this.caps.getChatCheckpointer();
  }

  getToolkitRuntimeManager() {
    return this.caps.getToolkitRuntimeManager();
  }

  getToolkitRuntimeDiagnostics() {
    return this.caps.getToolkitRuntimeDiagnostics();
  }

  getModelProfiles() {
    return this.caps.getModelProfiles();
  }

  getToolkitInventoryStore() {
    return this.caps.getToolkitInventoryStore();
  }

  getLocalCapabilities() {
    return this.caps.getLocalCapabilities();
  }

  getCapabilityArtifactStore() {
    return this.caps.getCapabilityArtifactStore();
  }

  getUserCapabilities() {
    return this.caps.getUserCapabilities();
  }

  async rescanUserCapabilities() {
    return this.caps.rescanUserCapabilities();
  }

  getActorId(): string {
    return this.caps.getActorId();
  }

  getActorName(): string | null {
    return this.caps.getActorName();
  }

  // ---- Chat/ws-relay concerns (host-specific) ----

  private buildLocalServerDeps(): LocalServerDeps {
    return {
      serverMode: this.serverMode,
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

  async runForever(opts?: { skipInit?: boolean }) {
    if (!opts?.skipInit) {
      await this.init();
    }
    console.log('[local-agent] started — local server');

    // Nothing is polled any more — the scheduled hosted-app work went with the
    // relay — so this only parks until stop. The transport keeps itself alive.
    if (!this.stopRequested) {
      await new Promise<void>((resolve) => {
        this.stopController.signal.addEventListener(
          'abort',
          () => { resolve(); },
          { once: true },
        );
      });
    }

    console.log('[local-agent] stopped');
  }
}
