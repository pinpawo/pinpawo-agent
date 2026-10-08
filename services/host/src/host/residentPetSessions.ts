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
  // An answer is being resumed; the next one waits for its outcome.
  let reviewing = false;
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
      // One Pet runs one turn at a time, so a second answer would only fail
      // once admitted. Claim synchronously, before any await, so two answers
      // arriving together cannot both pass.
      if (reviewing || context.activeRuns.read()) {
        throw new PetSessionReviewRefusedError(
          'session_busy',
          'This Pet is running another turn. Wait for it to finish, then answer the current review.',
        );
      }
      reviewing = true;
      let handedOff = false;
      try {
        const snapshot = await readSnapshot(sessionId);
        if (snapshot.session.pendingInterrupt?.interruptId !== request.interruptId) {
          throw new PetSessionReviewRefusedError(
            'review_closed',
            'This review is no longer current. Reload the session and answer what is pending now.',
          );
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
        handedOff = true;
        void operation.catch((error) => {
          const message = error instanceof Error ? error.message : String(error);
          console.error('[resident-pet] session review failed:', message);
          // The caller already has its 202; the outcome belongs on the stream.
          context.publishSessionEvent(sessionId, {
            type: 'error', requestId: request.requestId, message,
          });
        }).finally(() => {
          release();
          reviewing = false;
        });
      } finally {
        if (!handedOff) reviewing = false;
      }
    },
  };
}
