import type { PetDocument } from '@pinpawo/pet-agent';
import { FileSaver } from './fileSaver';
import { HostCapabilityAssembly } from './hostCapabilityAssembly';
import {
  buildLocalAgentRuntimeConfig,
  type LocalAgentRuntimeConfig,
} from './config/runtimeConfig';
import type { ServerDeps } from './serverTypes';
import { DEFAULT_CHAT_PET } from './defaultPet';
import { loadPetConfigs, type PetConfig } from './config/petConfig';
import { loadPetDocumentFile, resolveChatPetDocumentPath } from './config/petDocument';
import { DEFAULT_SERVER_MODE, type ServerMode } from './config/serverMode';

/**
 * Chat Host — assembles capability supply via {@link HostCapabilityAssembly}
 * and serves the local transport (ws on 127.0.0.1, or stdio).
 *
 * The hosted-app relay and its Hasura-backed context were removed: clients
 * reach this host over the local transport only. Pet identity and context
 * now come from local config, and a future Studio plugin owns any remote
 * surface (#638).
 *
 * Studio is started from its own package and composes the exported resident
 * runtime/interaction surfaces; this Chat Host never imports it.
 */
/**
 * Chat runs one Pet. A second configuration file is a composition mistake
 * rather than an unsupported feature, so it fails loudly and points at the
 * Host that does own multi-Pet identity.
 */
export async function loadChatPetConfig(
  runtimeConfig: Pick<LocalAgentRuntimeConfig, 'petsDir'>,
): Promise<PetConfig> {
  const { petsDir } = runtimeConfig;
  const configs = await loadPetConfigs(petsDir);
  if (configs.length > 1) {
    throw new Error(
      `Chat Host runs one Pet, but ${configs.length.toString()} are configured in ${petsDir}. `
      + 'Use Studio to run several Pets.',
    );
  }
  return configs[0] ?? DEFAULT_CHAT_PET;
}

export class AgentHost {
  private readonly caps: HostCapabilityAssembly;
  private readonly serverMode: ServerMode;
  private petDocument: PetDocument | null = null;
  private petConfig: PetConfig = DEFAULT_CHAT_PET;
  private stopRequested = false;
  private readonly stopController = new AbortController();
  constructor(
    runtimeConfig: LocalAgentRuntimeConfig = buildLocalAgentRuntimeConfig(),
    serverMode: ServerMode = DEFAULT_SERVER_MODE,
  ) {
    this.caps = new HostCapabilityAssembly({
      runtimeConfig,
      sourceId: 'local-agent',
      // Preserve the existing Chat session namespace while sharing its writer.
      checkpointPath: runtimeConfig.tuiCheckpointPath,
    });
    this.serverMode = serverMode;
  }

  async init() {
    this.petConfig = await loadChatPetConfig(this.getRuntimeConfig());
    this.petDocument = await loadPetDocumentFile(resolveChatPetDocumentPath(
      this.getRuntimeConfig().workdir,
    ));
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

  /** This Chat Host's conversation checkpointer. */
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

  getCapabilityCatalog() {
    return this.caps.getCapabilityCatalog();
  }

  getCapabilityArtifactStore() {
    return this.caps.getCapabilityArtifactStore();
  }

  getPetConfig(): PetConfig {
    return this.petConfig;
  }

  getPetDocument(): PetDocument | null {
    return this.petDocument;
  }

  // ---- Chat/ws-relay concerns (host-specific) ----

  buildLocalServerDeps(): ServerDeps {
    return {
      serverMode: this.serverMode,
      petId: this.petConfig.petId,
      petName: this.petConfig.name,
      chatCheckpointer: this.getChatCheckpointer(),
      modelProfiles: this.getModelProfiles(),
      ...this.caps.getExecutionConfig(),
      toolkitInventory: this.getToolkitInventoryStore(),
      toolkitRuntimeManager: this.getToolkitRuntimeManager(),
      capabilityCatalog: this.getCapabilityCatalog(),
      ...(this.petDocument ? { petDocument: this.petDocument } : {}),
      capabilityArtifactStore: this.getCapabilityArtifactStore(),
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
