import { randomUUID } from 'node:crypto';
import type { AgentServerMessage } from '@pinpawo/agent-session';

import {
  PetSessionNotFoundError,
  PetSessionReviewRefusedError,
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
  const readSnapshot = async (sessionId: string, timelineLimit?: number) => {
    try {
      return await context.localHandlers.readSessionSnapshot(sessionId, timelineLimit);
    } catch (error) {
      throw readSessionNotFound(error, sessionId);
    }
  };

  return {
    snapshot: async (sessionId, options) => {
      assertOpen();
      return readSnapshot(sessionId, options?.timelineLimit);
    },
    observe: async (sessionId, listener, options) => {
      assertOpen();
      // Attach before reading, so a message published while the snapshot is
      // read is delivered after it instead of falling between the two.
      let buffered: AgentServerMessage[] | null = [];
      const detach = context.observeSession(sessionId, (message) => {
        if (buffered) buffered.push(message);
        else listener(message);
      });
      try {
        const snapshot = await readSnapshot(sessionId, options?.timelineLimit);
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
      const { completion } = await context.coordinator.submitReviewAnswer(async () => {
        const { peer, release } = context.openSessionPeer(sessionId);
        try {
          await context.localHandlers.resumeSessionInterrupt(peer, sessionId, {
            type: 'interrupt.resume',
            requestId: request.requestId,
            interruptId: request.interruptId,
            value: { decisions: request.value.decisions },
          });
        } finally {
          release();
        }
      }, async () => {
        const snapshot = await readSnapshot(sessionId);
        if (snapshot.session.pendingInterrupt?.interruptId !== request.interruptId) {
          throw new PetSessionReviewRefusedError(
            'review_closed',
            'This review is no longer current. Reload the session and answer what is pending now.',
          );
        }
      });
      // The caller already has its 202; the outcome belongs on the stream.
      void completion.catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        console.error('[resident-pet] session review failed:', message);
        context.publishSessionEvent(sessionId, { type: 'error', requestId: request.requestId, message });
      });
    },
  };
}
