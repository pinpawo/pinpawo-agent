import type {
  LocalAgentServerMessage,
  StudioRequestMessage,
} from './localAgentProtocol';
import {
  StudioNotConfiguredError,
  buildStudio,
  type BuildStudioInput,
  type BuildStudioResult,
} from './studio/buildStudio';
import { getLocalServerWorkdir, type LocalServerDeps } from './localServerTypes';
import type { AgentRuntimeEvent } from '@pinpawo/agent-session';

export type BuildStudio = (input: BuildStudioInput) => Promise<BuildStudioResult>;

export type LocalServerStudioOutbound<Peer extends object> = {
  sendMessage: (peer: Peer, message: LocalAgentServerMessage) => boolean;
  sendEvent: (peer: Peer, event: AgentRuntimeEvent) => boolean;
};

/**
 * Studio 的 ws 入口。
 *
 * **提交即返回**:把目标派给 entry pet 之后立即回应,不等结果 —— 推模型下
 * 没有人在等 pet(设计 §4.3)。进度与产出经插件的 event 流出,客户端订阅
 * `studio.progress` 即可。
 *
 * studio 按 workdir **常驻**:不再每请求重新装配 pet runtime 与 graph。
 */
export class LocalServerStudioHandler<Peer extends object> {
  private readonly outbound: LocalServerStudioOutbound<Peer>;
  private readonly buildStudio: BuildStudio;
  private readonly studios = new Map<string, Promise<BuildStudioResult>>();
  private readonly eventBridges = new WeakMap<Peer, () => void>();

  constructor(options: {
    outbound: LocalServerStudioOutbound<Peer>;
    buildStudio?: BuildStudio;
  }) {
    this.outbound = options.outbound;
    this.buildStudio = options.buildStudio ?? buildStudio;
  }

  /** 断开时只解绑事件桥;studio 本身常驻,不随连接生灭。 */
  rejectDisconnected(peer: Peer) {
    this.eventBridges.get(peer)?.();
    this.eventBridges.delete(peer);
  }

  async shutdown(): Promise<void> {
    const pending = [...this.studios.values()];
    this.studios.clear();
    for (const entry of pending) {
      await entry.then(({ studio }) => studio.shutdown()).catch(() => undefined);
    }
  }

  private getStudio(deps: LocalServerDeps): Promise<BuildStudioResult> {
    const workdir = getLocalServerWorkdir(deps);
    const existing = this.studios.get(workdir);
    if (existing) return existing;

    const pending = this.buildStudio({
      modelProfiles: deps.modelProfiles,
      capabilities: [
        ...(deps.localCapabilities ?? []),
        ...(deps.userCapabilities ?? []).map((item) => item.capability),
      ],
      toolkits: [...(deps.pluginToolkits ?? []), ...(deps.localToolkits ?? [])],
      ...(deps.toolkitRuntimeManager ? { toolkitRuntimeManager: deps.toolkitRuntimeManager } : {}),
      ...(deps.chatCheckpointer ? { checkpoint: deps.chatCheckpointer } : {}),
      ownerUserId: null,
      workdir,
      ...(deps.runtimeConfig ? {
        studioConfigPath: deps.runtimeConfig.studioConfigPath,
        petsDir: deps.runtimeConfig.petsDir,
      } : {}),
    }).catch((error: unknown) => {
      // 装配失败不缓存,否则一次配置错误会让这个 workdir 永久不可用。
      this.studios.delete(workdir);
      throw error;
    });

    this.studios.set(workdir, pending);
    return pending;
  }

  async handleStudioRequest(peer: Peer, msg: StudioRequestMessage, deps: LocalServerDeps) {
    const { requestId, userRequest } = msg;
    const send = (message: LocalAgentServerMessage) => {
      this.outbound.sendMessage(peer, message);
    };

    try {
      const { studio } = await this.getStudio(deps);

      if (!this.eventBridges.has(peer)) {
        this.eventBridges.set(peer, studio.subscribe((event) => {
          this.outbound.sendEvent(peer, {
            type: 'studio.progress',
            requestId,
            event: { ...event } as unknown as Record<string, unknown>,
          });
        }));
      }

      const { threadId } = await studio.submitRequest(userRequest);
      console.log(
        `[local-server] studio_request accepted requestId=${requestId} thread=${threadId}`,
      );

      // reply 为空是刻意的:提交时还没有结果,产出经 event 流出。
      send({
        type: 'studio_response',
        requestId,
        outcome: 'done',
        reply: '',
        workdir: getLocalServerWorkdir(deps),
      });
    } catch (error) {
      const message = error instanceof StudioNotConfiguredError
        ? `Studio 未配置:${error.message}`
        : error instanceof Error ? error.message : String(error);
      if (!(error instanceof StudioNotConfiguredError)) {
        console.error('[local-server] handleStudioRequest error:', message);
      }
      send({ type: 'studio_error', requestId, message });
    }
  }
}
