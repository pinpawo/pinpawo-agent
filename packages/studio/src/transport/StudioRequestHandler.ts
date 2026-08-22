import { randomUUID } from 'node:crypto';
import type { JsonObject } from '@pinpawo/agent-contracts';
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
  accepted: boolean;
  pending: StudioServerMessage[];
  terminal: boolean;
};

function withoutTransportRoute(
  metadata: Readonly<JsonObject> | undefined,
): JsonObject | undefined {
  if (!metadata) return undefined;
  const { transportRouteId: _transportRouteId, ...producerMetadata } = metadata;
  return Object.keys(producerMetadata).length > 0 ? producerMetadata : undefined;
}

export type StudioWireOutbound<Peer extends object> = {
  send: (peer: Peer, message: StudioServerMessage) => boolean;
};

/**
 * Studio 的 local-agent transport 入口（WebSocket / stdio 共用）。
 *
 * **提交即返回**:收到 dispatch receipt 后立即回应,不等待 invocation 完成。
 * invocation 状态和显式携带 transport route 的插件 event 经 Studio
 * 自己的 wire message 投射；无关联的全局事件不会跨 peer 广播。
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
  private readonly unsubscribeEvents: () => void;
  private readonly unsubscribeInvocations: () => void;

  constructor(options: {
    outbound: StudioWireOutbound<Peer>;
    /** Resident Studio built by StudioHost at init time. */
    studio: Studio;
  }) {
    this.outbound = options.outbound;
    this.studio = options.studio;
    this.unsubscribeEvents = this.studio.subscribe((event) => {
      const routeId = typeof event.metadata?.transportRouteId === 'string'
        ? event.metadata.transportRouteId
        : null;
      if (!routeId) return;
      const route = this.routes.get(routeId);
      if (!route) return;
      const metadata = withoutTransportRoute(event.metadata);
      this.sendRouted(routeId, {
        type: 'studio.event',
        deliveryId: route.deliveryId,
        event: {
          ...event,
          ...(metadata ? { metadata } : {}),
        },
      });
    });
    this.unsubscribeInvocations = this.studio.onInvocation((event) => {
      const routeId = typeof event.metadata?.transportRouteId === 'string'
        ? event.metadata.transportRouteId
        : null;
      if (!routeId) return;
      this.sendInvocationProgress(routeId, event);
    });
  }

  private sendInvocationProgress(
    routeId: string,
    event: StudioInvocationEvent,
  ): void {
    const route = this.routes.get(routeId);
    if (!route) return;
    const metadata = withoutTransportRoute(event.metadata);
    const terminal = event.status !== 'busy';
    this.sendRouted(routeId, {
      type: 'studio.invocation',
      deliveryId: route.deliveryId,
      petId: event.petId,
      threadId: event.threadId,
      invocationId: event.invocationId,
      status: event.status,
      ...(metadata ? { metadata } : {}),
      ...(event.output ? { output: event.output } : {}),
      ...(event.pendingInterrupt
        ? { pendingInterrupt: event.pendingInterrupt }
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
    if (!route.accepted) {
      route.pending.push(message);
      route.terminal ||= terminal;
      return;
    }
    this.outbound.send(route.peer, message);
    if (terminal) this.deleteRoute(routeId);
  }

  private acceptRoute(routeId: string): void {
    const route = this.routes.get(routeId);
    if (!route) return;
    route.accepted = true;
    for (const message of route.pending) {
      this.outbound.send(route.peer, message);
    }
    route.pending.length = 0;
    if (route.terminal) this.deleteRoute(routeId);
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
    this.unsubscribeInvocations();
    this.routes.clear();
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
      accepted: false,
      pending: [],
      terminal: false,
    });
    const peerRoutes = this.routeIdsByPeer.get(peer) ?? new Set<string>();
    peerRoutes.add(routeId);
    this.routeIdsByPeer.set(peer, peerRoutes);

    try {
      const producerMetadata = msg.metadata;
      const receipt = await this.studio.dispatch({
        petId: msg.petId,
        input: msg.input,
        metadata: {
          ...producerMetadata,
          transportRouteId: routeId,
        },
        ...(msg.idempotencyKey
          ? { idempotencyKey: msg.idempotencyKey }
          : {}),
      });
      console.log(
        `[studio-host] dispatch accepted deliveryId=${deliveryId} `
        + `thread=${receipt.threadId} invocation=${receipt.invocationId}`,
      );

      const receiptRouteId = typeof receipt.metadata?.transportRouteId === 'string'
        ? receipt.metadata.transportRouteId
        : null;
      if (receiptRouteId !== routeId) {
        // An idempotency hit returns the original receipt and does not emit a
        // second invocation lifecycle. Project its terminal result to this
        // retry's transport route as well, including after reconnect.
        void receipt.completion.then(
          (result) => this.sendInvocationProgress(routeId, result),
          () => this.deleteRoute(routeId),
        );
      }

      const metadata = withoutTransportRoute(receipt.metadata);
      send({
        type: 'studio.accepted',
        deliveryId,
        petId: receipt.petId,
        threadId: receipt.threadId,
        invocationId: receipt.invocationId,
        ...(metadata ? { metadata } : {}),
      });
      this.acceptRoute(routeId);
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
