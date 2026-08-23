import { randomUUID } from 'node:crypto';
import type {
  LocalServerWireHandlers,
  LocalServerWirePeer,
} from 'pinpawo/local-server-transport';
import type { Studio, StudioInvocationEvent } from '../studioContract';
import {
  parseStudioClientMessage,
  readStudioClientMessageEnvelope,
  type StudioDispatchMessage,
  type StudioServerMessage,
} from './studioProtocol';

type StudioRequestRoute<Peer extends object> = {
  peer: Peer;
  deliveryId: string;
  unsubscribeInvocation?: () => void;
};

export type StudioWireOutbound<Peer extends object> = {
  send: (peer: Peer, message: StudioServerMessage) => boolean;
};

/**
 * Studio 的 local-agent transport 入口（WebSocket / stdio 共用）。
 *
 * **提交即返回**:收到 dispatch receipt 后立即回应,不等待 invocation 完成。
 * invocation 状态通过 receipt-scoped observer 投射。Plugin event 保持
 * Studio 进程内总线语义，不被隐式归到某个 transport request。
 *
 * Studio 由 {@link StudioHost} 在 init 时构建并注入;handler 不拥有
 * studio 生命周期,也不按 workdir 缓存。请求只 invoke 常驻 studio。
 */
export class StudioRequestHandler<Peer extends object> {
  private readonly outbound: StudioWireOutbound<Peer>;
  private readonly studio: Studio;
  /** transport route id -> 精确的 peer/delivery。绝不使用“peer 最近请求”。 */
  private readonly routes = new Map<string, StudioRequestRoute<Peer>>();
  private readonly routeIdsByPeer = new WeakMap<Peer, Set<string>>();

  constructor(options: {
    outbound: StudioWireOutbound<Peer>;
    /** Resident Studio built by StudioHost at init time. */
    studio: Studio;
  }) {
    this.outbound = options.outbound;
    this.studio = options.studio;
  }

  private sendInvocationProgress(
    routeId: string,
    event: StudioInvocationEvent,
  ): void {
    const route = this.routes.get(routeId);
    if (!route) return;
    const terminal = event.status !== 'busy';
    this.sendRouted(routeId, {
      type: 'studio.invocation',
      deliveryId: route.deliveryId,
      petId: event.petId,
      threadId: event.threadId,
      invocationId: event.invocationId,
      status: event.status,
      ...(event.metadata ? { metadata: event.metadata } : {}),
      ...(event.output ? { output: event.output } : {}),
      ...(event.pendingContinuation
        ? { pendingContinuation: event.pendingContinuation }
        : {}),
      ...(event.error ? { error: event.error } : {}),
    }, terminal);
  }

  private sendRouted(
    routeId: string,
    message: StudioServerMessage,
    terminal = false,
  ): void {
    const route = this.routes.get(routeId);
    if (!route) return;
    this.outbound.send(route.peer, message);
    if (terminal) this.deleteRoute(routeId);
  }

  private deleteRoute(routeId: string): void {
    const route = this.routes.get(routeId);
    if (!route) return;
    this.routes.delete(routeId);
    route.unsubscribeInvocation?.();
    const peerRoutes = this.routeIdsByPeer.get(route.peer);
    peerRoutes?.delete(routeId);
    if (peerRoutes?.size === 0) this.routeIdsByPeer.delete(route.peer);
  }

  /** 断开时只清掉该 peer 的 request route;studio 本身常驻。 */
  rejectDisconnected(peer: Peer) {
    for (const routeId of this.routeIdsByPeer.get(peer) ?? []) {
      this.deleteRoute(routeId);
    }
    this.routeIdsByPeer.delete(peer);
  }

  /** transport 关闭时释放所有 request-scoped invocation 订阅。 */
  close() {
    for (const routeId of [...this.routes.keys()]) this.deleteRoute(routeId);
  }

  async handleMessage(peer: Peer, data: Buffer | string) {
    const message = parseStudioClientMessage(data);
    if (!message) {
      const envelope = readStudioClientMessageEnvelope(data);
      if (envelope?.deliveryId) {
        this.outbound.send(peer, {
          type: 'studio.error',
          deliveryId: envelope.deliveryId,
          message: 'Studio client message is invalid or incompatible.',
        });
      }
      return;
    }
    if (message.type === 'ping') {
      this.outbound.send(peer, { type: 'pong' });
      return;
    }
    await this.handleStudioRequest(peer, message);
  }

  async handleStudioRequest(peer: Peer, msg: StudioDispatchMessage) {
    const { deliveryId } = msg;
    const send = (message: StudioServerMessage) => {
      this.outbound.send(peer, message);
    };

    const routeId = `studio-route:${randomUUID()}`;
    this.routes.set(routeId, {
      peer,
      deliveryId,
    });
    const peerRoutes = this.routeIdsByPeer.get(peer) ?? new Set<string>();
    peerRoutes.add(routeId);
    this.routeIdsByPeer.set(peer, peerRoutes);

    try {
      const receipt = await this.studio.dispatch({
        petId: msg.petId,
        input: msg.input,
        ...(msg.metadata ? { metadata: msg.metadata } : {}),
        ...(msg.idempotencyKey
          ? { idempotencyKey: msg.idempotencyKey }
          : {}),
      });
      console.log(
        `[studio-host] dispatch accepted deliveryId=${deliveryId} `
        + `thread=${receipt.threadId} invocation=${receipt.invocationId}`,
      );

      send({
        type: 'studio.accepted',
        deliveryId,
        petId: receipt.petId,
        threadId: receipt.threadId,
        invocationId: receipt.invocationId,
        ...(receipt.metadata ? { metadata: receipt.metadata } : {}),
      });
      const unsubscribe = receipt.onInvocation((event) => {
        this.sendInvocationProgress(routeId, event);
      });
      const route = this.routes.get(routeId);
      if (route) route.unsubscribeInvocation = unsubscribe;
      else unsubscribe();
    } catch (error) {
      this.deleteRoute(routeId);
      const message = error instanceof Error ? error.message : String(error);
      console.error('[studio-host] handleStudioRequest error:', message);
      send({ type: 'studio.error', deliveryId, message });
    }
  }
}

export function createStudioWireHandlers(
  handler: StudioRequestHandler<LocalServerWirePeer<StudioServerMessage>>,
): LocalServerWireHandlers<StudioServerMessage> {
  return {
    onMessage: (peer, data) => handler.handleMessage(peer, data),
    onClose: (peer) => handler.rejectDisconnected(peer),
  };
}
