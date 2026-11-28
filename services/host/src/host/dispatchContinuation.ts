import type { PendingInterruptProjection } from '@pinpawo/agent-session';
import type { AgentSessionTurnOptions, AgentSessionTurnResult } from '../agent/chatSessionAdapter';
import { projectPendingInterrupt } from '../conversation/pendingInterruptProjection';
import type { ServerTuiSessionService } from '../session/serverTuiSessions';
import { readPetDispatchMessage, type PetDispatchLifecycleEvent } from './contracts';
import type { ResidentPetCoordinator } from './residentPetCoordinator';
import { withPetInvocationContext } from './petInvocationContext';
import { withInvocationContext } from './invocationSystemContext';

type RunAgentTurn = (options: AgentSessionTurnOptions) => Promise<AgentSessionTurnResult>;

function isAbortError(error: unknown): boolean {
  return error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError');
}

/** A review answer is a new dispatch identity over the existing Session's resume path, not a FIFO item. */
export function continueSuspendedDispatch(options: {
  petId: string;
  sessions: ServerTuiSessionService;
  coordinator: ResidentPetCoordinator;
  publishLifecycle: (event: PetDispatchLifecycleEvent) => void;
  run: RunAgentTurn;
}): RunAgentTurn {
  const { petId, sessions, coordinator, publishLifecycle, run } = options;
  return async (turn) => {
    if (turn.request.kind !== 'resume') return run(turn);
    const session = sessions.findSessionByThread(petId, turn.setup.input.threadId);
    const suspended = session?.pendingDispatch;
    if (!session || suspended?.interruptId !== turn.request.resume.interruptId) return run(turn);

    return coordinator.runReviewDispatch(
      {
        resumesDispatchId: suspended.dispatchId, scope: suspended.scope,
        request: suspended.request, requestId: turn.request.requestId, sessionId: session.id,
      },
      publishLifecycle,
      async (dispatchId, report) => {
        const remember = (pending: PendingInterruptProjection | null) => {
          if (!pending) sessions.setPendingDispatch(session.id, null);
          else if (pending.interruptId !== suspended.interruptId) {
            sessions.setPendingDispatch(session.id, { ...suspended, dispatchId, interruptId: pending.interruptId });
          }
        };
        const suspend = (pending: PendingInterruptProjection) => {
          sessions.setPendingDispatch(session.id, { ...suspended, dispatchId, interruptId: pending.interruptId });
          report({ state: 'waiting', pendingInterrupt: pending });
        };
        const readPending = async () => {
          const pending = await turn.graphService.settleAbortedRun(turn.setup);
          return pending ? projectPendingInterrupt(pending) : null;
        };

        let pendingInterrupt: PendingInterruptProjection | undefined;
        let result: AgentSessionTurnResult;
        try {
          result = await withPetInvocationContext(
            { petId, dispatchId, sessionId: session.id, ...(suspended.scope ? { scope: suspended.scope } : {}) },
            () => run({
              ...turn,
              setup: withInvocationContext(turn.setup, suspended),
              emitEvent: (event) => {
                if (event.type === 'interrupt.requested') pendingInterrupt = event.pendingInterrupt;
                const message = readPetDispatchMessage(event);
                if (message) report({ state: 'message', message });
                turn.emitEvent(event);
              },
            }),
          );
        } catch (error) {
          // Checkpoint recovery does not turn a failed answer into a waiting answer.
          const pending = await readPending();
          if (turn.setup.input.signal?.aborted || isAbortError(error)) {
            if (pending) suspend(pending);
            else { remember(null); report({ state: 'interrupted' }); }
          } else {
            remember(pending);
          }
          throw error;
        }
        if (result.status === 'completed') {
          remember(null);
          report({ state: 'completed', reply: result.reply });
        } else if (result.status === 'waiting') {
          const read = pendingInterrupt ? null : (await turn.graphService.readThreadState(turn.setup)).pendingInterrupt;
          const pending = pendingInterrupt ?? (read ? projectPendingInterrupt(read) : null);
          if (!pending) throw new Error('A waiting dispatch has no pending interrupt.');
          suspend(pending);
        } else {
          const pending = await readPending();
          if (pending) suspend(pending);
          else { remember(null); report({ state: 'interrupted' }); }
        }
        return result;
      },
    );
  };
}
