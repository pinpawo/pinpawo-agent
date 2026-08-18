import type {
  LocalAgentServerMessage,
  StudioRequestMessage,
} from './localAgentProtocol';
import {
  getLocalServerWorkdir,
  type LocalServerDeps,
} from './localServerTypes';
import type { AgentRuntimeEvent } from '@pinpawo/agent-session';
import type { Studio } from '@pinpawo/studio';

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
 * Studio 由 {@link StudioHost} 在 init 时构建并注入;handler 不拥有
 * studio 生命周期,也不按 workdir 缓存。请求只 invoke 常驻 studio。
 */
export class LocalServerStudioHandler<Peer extends object> {
  private readonly outbound: LocalServerStudioOutbound<Peer>;
  private readonly studio: Studio;
  /**
   * 每个 peer 一座事件桥。`requestId` 存在可变盒子里而**不是闭包捕获** ——
   * 桥只建一次,若把首次的 requestId 封进闭包,第二次提交产生的事件会
   * 全部错误归到第一次请求上。
   */
  private readonly eventBridges = new WeakMap<Peer, {
    unsubscribe: () => void;
    latestRequestId: { current: string };
  }>();

  constructor(options: {
    outbound: LocalServerStudioOutbound<Peer>;
    /** Resident Studio built by StudioHost at init time. */
    studio: Studio;
  }) {
    this.outbound = options.outbound;
    this.studio = options.studio;
  }

  /** 断开时只解绑事件桥;studio 本身常驻,不随连接生灭。 */
  rejectDisconnected(peer: Peer) {
    this.eventBridges.get(peer)?.unsubscribe();
    this.eventBridges.delete(peer);
  }

  async handleStudioRequest(peer: Peer, msg: StudioRequestMessage, deps: LocalServerDeps) {
    const { requestId, userRequest } = msg;
    const send = (message: LocalAgentServerMessage) => {
      this.outbound.sendMessage(peer, message);
    };

    try {
      const bridge = this.eventBridges.get(peer);
      if (bridge) {
        // 桥已在,只把归属指向本次提交。
        bridge.latestRequestId.current = requestId;
      } else {
        const latestRequestId = { current: requestId };
        const unsubscribe = this.studio.subscribe((event) => {
          this.outbound.sendEvent(peer, {
            type: 'studio.progress',
            requestId: latestRequestId.current,
            event: { ...event } as unknown as Record<string, unknown>,
          });
        });
        this.eventBridges.set(peer, { unsubscribe, latestRequestId });
      }

      const { threadId } = await this.studio.dispatch({ petId: this.studio.entryPetId, request: userRequest });
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
      const message = error instanceof Error ? error.message : String(error);
      console.error('[local-server] handleStudioRequest error:', message);
      send({ type: 'studio_error', requestId, message });
    }
  }
}
