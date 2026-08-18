/**
 * #643: Studio 独立 Host。
 *
 * Studio 不再是 chat host 的一个分支。它有自己的入口、自己的
 * `HostToolkitCoordinator`、`FileSaver` 和 studio handler。
 *
 * `StudioHost` 负责:
 * - 装配 host built-in Toolkit(bash/git/browser)与 plugin Toolkit;
 * - 加载 Capability registry(local + user);
 * - 持有 `HostToolkitCoordinator`(inventory + runtime manager);
 * - 持有 `FileSaver`(共享 checkpointer);
 * - 提供 `LocalServerDeps` 给 local server / stdio transport。
 *
 * Studio handler 由 `runAgent` 在 transport 层创建并注入，不在此处持有 ——
 * 因为 handler 的 outbound 绑定具体 peer 类型(`LocalServerPeer` 或
 * `WebSocket`)，属于 transport 层的关注点。
 *
 * 它不负责 chat session、TUI session、ws relay —— 那些归 `LocalAgentRuntime`。
 * 当 studio mode 需要接收 chat 请求(人工解开卡住的 pet)时,chat 请求走
 * `LocalServerChatHandler`,与 studio request 共享同一 local server。
 */
import {
  type AgentCapability,
  type AgentToolkit,
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
import { loadStoredConfig } from './storage';
import {
  createCoreLocalCapabilities,
  LocalAgentCapabilityRegistry,
} from './localAgentCapabilityRegistry';
import {
  buildLocalAgentRuntimeConfig,
  findLegacyLocalAgentState,
  type LocalAgentRuntimeConfig,
} from './runtimeConfig';
import type { LocalServerDeps, LocalServerStudioModeInfo } from './localServerTypes';
import { getConfig } from './config';
import { loadAgentContext } from './contextLoader';
import { createBashToolkit, createGitToolkit } from './toolkits/local';
import { HostToolkitCoordinator } from './toolkits/hostToolkitCoordinator';
import type { HostToolkitInventoryStore } from './toolkits/toolkitInventory';
import { FileSaver } from './fileSaver';

export type StudioHostOptions = {
  runtimeConfig?: LocalAgentRuntimeConfig;
  studioMode?: LocalServerStudioModeInfo;
};

export class StudioHost {
  private readonly runtimeConfig: LocalAgentRuntimeConfig;
  private readonly studioModeInfo: LocalServerStudioModeInfo | undefined;
  private actorId: string | null = null;
  private actorName: string | null = null;
  private modelProfiles: LocalModelProfileRegistry | null = null;
  private readonly toolkitCoordinator = new HostToolkitCoordinator();
  private readonly hostBuiltInToolkits: readonly AgentToolkit[];
  private readonly capabilityRegistry: LocalAgentCapabilityRegistry;
  private readonly chatCheckpointer: FileSaver;
  private legacyStateNoticeReported = false;

  constructor(options: StudioHostOptions = {}) {
    this.runtimeConfig = options.runtimeConfig ?? buildLocalAgentRuntimeConfig();
    this.studioModeInfo = options.studioMode;
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
          '[studio-host] Capability V2 uses a new conversation checkpoint namespace. '
          + `Legacy state is preserved but not loaded: ${legacyStatePaths.join(', ')}`,
        );
      }
    }
    const { toolkitSources } = await loadPlugins();
    this.modelProfiles = buildLocalModelProfileRegistry();
    await this.toolkitCoordinator.initialize([
      ...toolkitSources,
      {
        id: 'studio-host',
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
    }
  }

  requestStop() {
    // Studio host does not own a ws relay loop; just a marker.
  }

  async shutdown() {
    this.requestStop();
    await this.toolkitCoordinator.shutdown();
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

  getCapabilityArtifactStore() {
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
      throw new Error('Studio host actorId is not initialized');
    }
    return this.actorId;
  }

  getActorName(): string | null {
    return this.actorName;
  }

  getStudioModeInfo(): LocalServerStudioModeInfo | undefined {
    return this.studioModeInfo;
  }

  buildLocalServerDeps(): LocalServerDeps {
    return {
      serverMode: 'studio',
      ...(this.studioModeInfo ? { studioMode: this.studioModeInfo } : {}),
      actorId: this.getActorId(),
      actorName: this.actorName ?? undefined,
      chatCheckpointer: this.chatCheckpointer,
      modelProfiles: this.getModelProfiles(),
      globalReviewPolicyMode: getConfig().globalReviewPolicyMode,
      autoAuthorizationSafetyLevel: getConfig().autoAuthorizationSafetyLevel,
      workdir: this.runtimeConfig.workdir,
      runtimeConfig: this.runtimeConfig,
      toolkitInventory: this.getToolkitInventoryStore(),
      toolkitRuntimeManager: this.getToolkitRuntimeManager(),
      localCapabilities: this.getLocalCapabilities(),
      userCapabilities: this.getUserCapabilities(),
      capabilityArtifactStore: this.getCapabilityArtifactStore(),
      rescanUserCapabilities: () => this.rescanUserCapabilities(),
    };
  }
}
