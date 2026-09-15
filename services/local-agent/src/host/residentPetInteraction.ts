import { dispatchLocalServerMessage } from '../wire/messageDispatcher';
import {
  ResidentPetInteractionBusyError,
  type ResidentPetInteraction,
} from './contracts';
import {
  readResidentPetRuntimeContext,
  type ResidentPetRuntime,
} from './runtimeContext';

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
    connect: (peer) => {
      if (context.isClosing()) throw new Error('Resident Pet interaction is closed.');
      // One interactive connection per Host. Everything else reaches a Pet
      // through dispatch, which is queued behind the availability gate — that
      // is what dispatch is for. Two interactive clients would instead race
      // over shared session state (the active session pointer is per-Pet), and
      // the runtime already assumes a single interaction elsewhere: the run
      // register is one value per Host and throws on a second claim.
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
