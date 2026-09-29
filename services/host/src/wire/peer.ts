import {
  buildHostEventEnvelope,
  type HostServerMessage,
} from './protocol';
import type { AgentRuntimeEvent } from '@pinpawo/agent-session';
import type { ServerWirePeer } from './framing';

/**
 * One client connected to the host server.
 *
 * Object identity scopes transport-local inflight delivery and per-peer queues.
 * The transport adapter owns framing, authentication, and connection lifecycle.
 */
export type ServerPeer = ServerWirePeer<HostServerMessage>;

/**
 * The local server transport is a trusted loopback peer, so it retains native
 * operation payloads and streaming message deltas.
 */
export function sendLocalServerPeerEvent(
  peer: ServerPeer,
  event: AgentRuntimeEvent,
) {
  return peer.send(buildHostEventEnvelope(event));
}
