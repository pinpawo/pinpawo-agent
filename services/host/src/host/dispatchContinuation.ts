import type { RunReviewTurn } from '../agent/serverChatHandler';
import type { runAgentSessionTurn } from '../agent/chatSessionAdapter';
import type { ServerTuiSessionService } from '../session/serverTuiSessions';
import { readPetDispatchMessage, type PetDispatchLifecycleEvent } from './contracts';
import type { ResidentPetCoordinator } from './residentPetCoordinator';
import { withPetInvocationContext, withoutPetInvocationContext } from './petInvocationContext';
import { withInvocationContext } from './invocationSystemContext';

/** Attribute a validated review resume without interpreting Agent state. */
export function attributeReviewDispatch(options: {
  petId: string;
  sessions: Pick<ServerTuiSessionService, 'setPendingDispatch'>;
  coordinator: ResidentPetCoordinator;
  publishLifecycle: (event: PetDispatchLifecycleEvent) => void;
  run: typeof runAgentSessionTurn;
}): RunReviewTurn {
  const { petId, sessions, coordinator, publishLifecycle, run } = options;
  return (session, request, execute) => {
    const suspended = session.pendingDispatch;
    if (suspended?.interruptId !== request.resume.interruptId) return execute();
    return coordinator.runReviewDispatch(
      {
        resumesDispatchId: suspended.dispatchId, scope: suspended.scope,
        request: suspended.request, requestId: request.requestId, sessionId: session.id,
      },
      publishLifecycle,
      async (dispatchId, report) => {
        const result = await execute((turn) => withoutPetInvocationContext(() =>
          withPetInvocationContext(
            { petId, dispatchId, sessionId: session.id, ...(suspended.scope ? { scope: suspended.scope } : {}) },
            () => run({
              ...turn,
              setup: withInvocationContext(turn.setup, suspended),
              emitEvent: (event) => {
                const message = readPetDispatchMessage(event);
                if (message) report({ state: 'message', message });
                turn.emitEvent(event);
              },
            }),
          ),
        ));
        const { outcome, pendingInterrupt, reply, error } = result;
        if (pendingInterrupt === null) {
          sessions.setPendingDispatch(session.id, null);
        } else if (pendingInterrupt && (outcome === 'waiting' || pendingInterrupt.interruptId !== suspended.interruptId)) {
          sessions.setPendingDispatch(session.id, { ...suspended, dispatchId, interruptId: pendingInterrupt.interruptId });
        }
        if (outcome === 'failed' || outcome === 'fatal_failed') {
          report({ state: 'failed', error: error instanceof Error ? error.message : 'internal error' });
        } else {
          report({ state: outcome, ...(reply === undefined ? {} : { reply }),
            ...(outcome === 'waiting' ? { pendingInterrupt } : {}),
          });
        }
        return result;
      },
    );
  };
}
