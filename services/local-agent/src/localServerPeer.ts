import {
  buildLocalAgentEventEnvelope,
  type LocalAgentServerMessage,
} from './localAgentProtocol';
import type { AgentRuntimeEvent } from '@pinpawo/agent-session';

/**
 * One client connected to the local-agent server.
 *
 * Object identity scopes transport-local inflight delivery and per-peer queues.
 * The transport adapter owns framing, authentication, and connection lifecycle.
 */
export type LocalServerPeer = {
  isConnected: () => boolean;
  send: (message: LocalAgentServerMessage) => boolean;
};

/**
 * The local server transport is a trusted loopback peer, so it retains native
 * operation payloads and streaming message deltas.
 */
export function sendLocalServerPeerEvent(
  peer: LocalServerPeer,
  event: AgentRuntimeEvent,
) {
  return peer.send(buildLocalAgentEventEnvelope(event));
}
