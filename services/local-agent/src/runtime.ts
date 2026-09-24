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
 * The Pet this Chat Host serves.
 *
 * Chat runs exactly one Pet (§一.8: a Host is one Pet's host, and multi-Pet is
 * Studio holding several Hosts). That leaves three cases, and only one of them
 * is a choice:
 *
 * - one configured Pet — serve it;
 * - none — serve the standalone default, as an install that never wrote one
 *   always did;
 * - several — the directory belongs to Studio, so Chat serves the standalone
 *   default too rather than picking one of them.
 *
 * The last case used to fail. Refusing was defensible — picking one of several
 * would be a guess — but the standalone default is not a guess: it is a Pet of
 * its own (`local-only`), with its own session namespace, so a Chat session
 * started here cannot disturb the Pets Studio owns. Failing only forced the
 * user to move files around to get a Chat window.
 */
export async function loadChatPetConfig(
  runtimeConfig: Pick<LocalAgentRuntimeConfig, 'petsDir'>,
  log: (message: string) => void = console.log,
): Promise<PetConfig> {
  const { petsDir } = runtimeConfig;
  const configs = await loadPetConfigs(petsDir);
  if (configs.length === 1) return configs[0]!;
  if (configs.length > 1) {
    // Say which Pets are being passed over. Serving `local-only` beside four
    // configured Pets is correct but surprising, and silence would read as the
    // Host having picked one of them.
    log(
      `[local-agent] ${configs.length.toString()} Pets are configured in ${petsDir} `
      + `(${configs.map((config) => config.petId).join(', ')}). `
      + `Chat serves one Pet, so it runs the standalone "${DEFAULT_CHAT_PET.petId}" `
      + 'instead; use Studio to run those Pets.',
    );
  }
  return DEFAULT_CHAT_PET;
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
