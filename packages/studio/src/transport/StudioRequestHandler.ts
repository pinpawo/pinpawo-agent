import { randomUUID } from 'node:crypto';
import type {
  LocalAgentServerMessage,
  StudioRequestMessage,
  LocalServerTransportHandlers,
} from 'pinpawo/local-server-transport';
import type { AgentRuntimeEvent } from '@pinpawo/agent-session';
import type { Studio } from '../studioContract';

type StudioRequestRoute<Peer extends object> = {
  peer: Peer;
  requestId: string;
};

export type LocalServerStudioOutbound<Peer extends object> = {
  sendMessage: (peer: Peer, message: LocalAgentServerMessage) => boolean;
  sendEvent: (peer: Peer, event: AgentRuntimeEvent) => boolean;
};

/**
 * Studio 的 local-agent transport 入口（WebSocket / stdio 共用）。
 *
 * **提交即返回**:把目标派给 entry pet 之后立即回应,不等结果 —— 推模型下
 * 没有人在等 pet(设计 §4.3)。dispatch gate 与显式携带本请求 correlation
 * 的插件 event 经 `studio.progress` 投射；无关联的全局事件不会跨 peer 广播。
 *
 * Studio 由 {@link StudioHost} 在 init 时构建并注入;handler 不拥有
 * studio 生命周期,也不按 workdir 缓存。请求只 invoke 常驻 studio。
 */
export class StudioRequestHandler<Peer extends object> {
  private readonly outbound: LocalServerStudioOutbound<Peer>;
  private readonly studio: Studio;
  private readonly workdir: string;
  /** transport route id -> 精确的 peer/request。绝不使用“peer 最近请求”。 */
  private readonly routes = new Map<string, StudioRequestRoute<Peer>>();
  private readonly routeIdsByPeer = new WeakMap<Peer, Set<string>>();
  private readonly unsubscribeEvents: () => void;
  private readonly unsubscribeGates: () => void;

  constructor(options: {
    outbound: LocalServerStudioOutbound<Peer>;
    /** Resident Studio built by StudioHost at init time. */
    studio: Studio;
    workdir: string;
  }) {
    this.outbound = options.outbound;
    this.studio = options.studio;
    this.workdir = options.workdir;
    this.unsubscribeEvents = this.studio.subscribe((event) => {
      if (!event.correlationId) return;
      const route = this.routes.get(event.correlationId);
      if (!route) return;
      this.outbound.sendEvent(route.peer, {
        type: 'studio.progress',
        requestId: route.requestId,
        event: {
          ...event,
          // transport 内部 route id 不进入公开协议。
          correlationId: route.requestId,
        } as unknown as Record<string, unknown>,
      });
    });
    this.unsubscribeGates = this.studio.onDispatchGate((change) => {
      if (!change.correlationId) return;
      const route = this.routes.get(change.correlationId);
      if (!route) return;
      this.outbound.sendEvent(route.peer, {
        type: 'studio.progress',
        requestId: route.requestId,
        event: {
          type: 'studio.dispatch.gate',
          threadId: change.threadId,
          petId: change.petId,
          correlationId: route.requestId,
          state: change.state,
        },
      });
      if (change.state === 'open' || change.state === 'blocked') {
        this.deleteRoute(change.correlationId);
      }
    });
  }

  private deleteRoute(routeId: string): void {
    const route = this.routes.get(routeId);
    if (!route) return;
    this.routes.delete(routeId);
    const peerRoutes = this.routeIdsByPeer.get(route.peer);
    peerRoutes?.delete(routeId);
    if (peerRoutes?.size === 0) this.routeIdsByPeer.delete(route.peer);
  }

  /** 断开时只清掉该 peer 的 request route;studio 本身常驻。 */
  rejectDisconnected(peer: Peer) {
    for (const routeId of this.routeIdsByPeer.get(peer) ?? []) {
      this.routes.delete(routeId);
    }
    this.routeIdsByPeer.delete(peer);
  }

  /** transport 关闭时释放 Host 控制面订阅。 */
  close() {
    this.unsubscribeEvents();
    this.unsubscribeGates();
    this.routes.clear();
  }

  async handleStudioRequest(peer: Peer, msg: StudioRequestMessage) {
    const { requestId, userRequest } = msg;
    const send = (message: LocalAgentServerMessage) => {
      this.outbound.sendMessage(peer, message);
    };

    const routeId = `studio-route:${randomUUID()}`;
    this.routes.set(routeId, { peer, requestId });
    const peerRoutes = this.routeIdsByPeer.get(peer) ?? new Set<string>();
    peerRoutes.add(routeId);
    this.routeIdsByPeer.set(peer, peerRoutes);

    try {
      const { threadId } = await this.studio.dispatch({
        petId: this.studio.entryPetId,
        request: userRequest,
        correlationId: routeId,
      });
      console.log(
        `[local-server] studio_request accepted requestId=${requestId} thread=${threadId}`,
      );

      // reply 为空是刻意的:提交时还没有结果,产出经 event 流出。
      send({
        type: 'studio_response',
        requestId,
        outcome: 'done',
        reply: '',
        workdir: this.workdir,
      });
    } catch (error) {
      this.deleteRoute(routeId);
      const message = error instanceof Error ? error.message : String(error);
      console.error('[local-server] handleStudioRequest error:', message);
      send({ type: 'studio_error', requestId, message });
    }
  }
}

/** Minimal protocol surface for the Studio transport. Unsupported Chat
 * messages are rejected by the shared dispatcher because no Chat callbacks
 * are registered here. */
export function createStudioPeerHandlers(
  handler: StudioRequestHandler<import('pinpawo/local-server-transport').LocalServerPeer>,
): LocalServerTransportHandlers {
  return {
    onStudioRequest: (peer, message) => handler.handleStudioRequest(peer, message),
    onClose: (peer) => handler.rejectDisconnected(peer),
  };
}
