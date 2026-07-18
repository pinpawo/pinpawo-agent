import {
  buildLocalAgentEventEnvelope,
  type LocalAgentServerMessage,
  type SendLocalAgentEventOptions,
} from './localAgentProtocol';
import type { LocalAgentRuntimeEvent } from './events/localAgentRuntimeEvent';

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

export function sendLocalServerPeerEvent(
  peer: LocalServerPeer,
  event: LocalAgentRuntimeEvent,
  options: SendLocalAgentEventOptions = {},
) {
  return peer.send(buildLocalAgentEventEnvelope(event, options));
}
