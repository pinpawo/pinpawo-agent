import { randomUUID } from 'node:crypto';
import { buildAgentEventEnvelope, type AgentServerMessage } from '@pinpawo/agent-session';

import { dispatchLocalServerMessage } from '../wire/messageDispatcher';
import {
  ResidentPetInteractionBusyError,
  type ResidentPetInteraction,
} from './contracts';
import {
  readResidentPetRuntimeContext,
  type ResidentPetRuntime,
} from './runtimeContext';

function defaultLogError(message: string, error: unknown): void {
  console.error(message, error instanceof Error ? error.message : error);
}

/**
 * The interaction surface: the Host's single interactive connection.
 *
 * Exactly one client may hold it (domains §一.3b); everything else reaches the
 * Pet through dispatch. connect() refuses the extra client by throwing, and
 * the transport is responsible for turning that into a closed socket rather
 * than an unhandled exception — see wire/agentSessionRoute.
 */

export function createResidentPetInteraction(
  runtime: ResidentPetRuntime,
): ResidentPetInteraction {
  const context = readResidentPetRuntimeContext(runtime);
  const { peerHandlers, interactivePeer } = context;
  const interaction: ResidentPetInteraction = {
    snapshot: async () => {
      if (context.isClosing()) throw new Error('Resident Pet interaction is closed.');
      let result: AgentServerMessage | undefined;
      await peerHandlers.onSessionSnapshotGet({
        isConnected: () => true,
        send: (message) => { result = message; return true; },
      }, { type: 'session.snapshot.get', requestId: randomUUID() });
      if (!result) throw new Error('Session snapshot did not return a response.');
      return result;
    },
    getQueueSnapshot: () => context.coordinator.getQueueSnapshot(),
    subscribe: (listener) => {
      context.messageListeners.add(listener);
      return () => { context.messageListeners.delete(listener); };
    },
    request: async (message) => {
      if (context.isClosing()) throw new Error('Resident Pet interaction is closed.');
      await dispatchLocalServerMessage(context.hostPeer, JSON.stringify(message), peerHandlers, (_label, error) => {
        if (!('requestId' in message) || !message.requestId) {
          defaultLogError(_label, error);
          return;
        }
        context.hostPeer.send(buildAgentEventEnvelope({
          type: 'error',
          requestId: message.requestId,
          message: error instanceof Error ? error.message : 'Agent Session command failed.',
        }));
      });
    },
    connect: (peer) => {
      if (context.isClosing()) throw new Error('Resident Pet interaction is closed.');
      // WebSocket connection ownership remains exclusive. HTTP commands use
      // the Host peer and the same admission gate; SSE readers hold no peer.
      if (interactivePeer.current?.isConnected()) {
        throw new ResidentPetInteractionBusyError();
      }
      interactivePeer.current = peer;
    },
    handle: async (peer, message) => {
      if (context.isClosing() || interactivePeer.current !== peer) {
        throw new Error('Agent Session peer is not connected to this resident Pet.');
      }
      if (message.type === 'ping') {
        peer.send({ type: 'pong' });
        return;
      }
      await dispatchLocalServerMessage(peer, JSON.stringify(message), peerHandlers);
    },
    disconnect: async (peer) => {
      if (interactivePeer.current !== peer) return;
      interactivePeer.current = null;
      await peerHandlers.onClose(peer);
    },
    close: context.close,
  };

  return interaction;
}
