import { randomUUID } from 'node:crypto';
import type { AgentServerMessage } from '@pinpawo/agent-session';

import {
  PetSessionNotFoundError,
  type PetSessionPort,
} from './contracts';
import {
  readResidentPetRuntimeContext,
  type ResidentPetRuntime,
} from './runtimeContext';

function readSessionNotFound(error: unknown, sessionId: string): unknown {
  return (error as { code?: unknown } | null)?.code === 'session_not_found'
    ? new PetSessionNotFoundError(sessionId)
    : error;
}

/**
 * The exact-session surface: read and follow any session of this Pet, and
 * answer its current review.
 *
 * It sits beside the interaction surface rather than inside it. Observing
 * holds no interactive connection and never touches the active selection, so
 * a TUI attached to session A is unaffected by anyone reading session B. A
 * review answer runs through the same admission, checkpoint validation and
 * dispatch continuation as one from the TUI, bound to the addressed session's
 * own thread.
 */
export function createResidentPetSessions(runtime: ResidentPetRuntime): PetSessionPort {
  const context = readResidentPetRuntimeContext(runtime);
  const assertOpen = () => {
    if (context.isClosing()) throw new Error('Resident Pet sessions are closed.');
  };
  const readSnapshot = async (sessionId: string) => {
    try {
      return await context.localHandlers.readSessionSnapshot(sessionId);
    } catch (error) {
      throw readSessionNotFound(error, sessionId);
    }
  };

  return {
    snapshot: async (sessionId) => {
      assertOpen();
      return readSnapshot(sessionId);
    },
    observe: async (sessionId, listener) => {
      assertOpen();
      // Attach before reading, so a message published while the snapshot is
      // read is delivered after it instead of falling between the two.
      let buffered: AgentServerMessage[] | null = [];
      const detach = context.observeSession(sessionId, (message) => {
        if (buffered) buffered.push(message);
        else listener(message);
      });
      try {
        const snapshot = await readSnapshot(sessionId);
        listener({ type: 'session.snapshot.result', requestId: randomUUID(), snapshot });
        const pending = buffered;
        buffered = null;
        for (const message of pending) listener(message);
      } catch (error) {
        detach();
        throw error;
      }
      return detach;
    },
    review: async (sessionId, request) => {
      assertOpen();
      if (!context.sessions.getSession(runtime.petId, sessionId)) {
        throw new PetSessionNotFoundError(sessionId);
      }
      const { peer, release } = context.openSessionPeer(sessionId);
      // The Host owns the answer from here, independently of the caller.
      const operation = context.coordinator.holdForConversation(
        () => context.localHandlers.resumeSessionInterrupt(peer, sessionId, {
          type: 'interrupt.resume',
          requestId: request.requestId,
          interruptId: request.interruptId,
          value: { decisions: request.value.decisions },
        }),
      );
      void operation.catch((error) => {
        console.error(
          '[resident-pet] session review failed:',
          error instanceof Error ? error.message : error,
        );
      }).finally(release);
    },
  };
}
