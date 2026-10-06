import type { PendingInterruptProjection } from '@pinpawo/agent-session';
import type { AgentSessionTurnOptions, AgentSessionTurnResult } from '../agent/chatSessionAdapter';
import { projectPendingInterrupt } from '../conversation/pendingInterruptProjection';
import type { ServerTuiSessionService } from '../session/serverTuiSessions';
import type { PetDispatchLifecycleEvent } from './contracts';
import { withPetInvocationContext } from './petInvocationContext';

type RunAgentTurn = (options: AgentSessionTurnOptions) => Promise<AgentSessionTurnResult>;

function isAbortError(error: unknown): boolean {
  return error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError');
}

/**
 * A dispatch that stopped on a review is resumed through the conversation
 * surface, not the dispatch queue. When a resume answers the interrupt the
 * session recorded for a dispatch, that turn is the dispatch's continuation:
 * it runs under the original attribution and reports under the original
 * dispatch identity. Any other resume is an ordinary conversation turn.
 */
export function continueSuspendedDispatch(options: {
  petId: string;
  sessions: ServerTuiSessionService;
  publishLifecycle: (event: PetDispatchLifecycleEvent) => void;
  run: RunAgentTurn;
}): RunAgentTurn {
  const { petId, sessions, publishLifecycle, run } = options;
  return async (turn) => {
    if (turn.request.kind !== 'resume') return run(turn);
    const session = sessions.findSessionByThread(petId, turn.setup.input.threadId);
    const suspended = session?.pendingDispatch;
    if (!session || suspended?.interruptId !== turn.request.resume.interruptId) return run(turn);

    const { dispatchId, request, scope } = suspended;
    const requestId = turn.request.requestId;
    const report = (event: Pick<PetDispatchLifecycleEvent, 'state' | 'reply' | 'error' | 'pendingInterrupt'>) => publishLifecycle({
      ...event, dispatchId, request, requestId, sessionId: session.id, ...(scope ? { scope } : {}),
    });
    const suspend = (pendingInterrupt: PendingInterruptProjection) => {
      sessions.setPendingDispatch(session.id, { ...suspended, interruptId: pendingInterrupt.interruptId });
      report({ state: 'waiting', pendingInterrupt });
    };
    const settle = (event: Parameters<typeof report>[0]) => {
      sessions.setPendingDispatch(session.id, null);
      report(event);
    };
    // A stop or failure can leave a review pending, the answered one included.
    // The dispatch is then still waiting on it rather than finished.
    const readPending = async () => {
      const pending = await turn.graphService.settleAbortedRun(turn.setup);
      return pending ? projectPendingInterrupt(pending) : null;
    };

    let pendingInterrupt: PendingInterruptProjection | undefined;
    report({ state: 'running' });
    let result: AgentSessionTurnResult;
    try {
      result = await withPetInvocationContext(
        { petId, dispatchId, sessionId: session.id, ...(scope ? { scope } : {}) },
        () => run({
          ...turn,
          emitEvent: (event) => {
            if (event.type === 'interrupt.requested') pendingInterrupt = event.pendingInterrupt;
            turn.emitEvent(event);
          },
        }),
      );
    } catch (error) {
      // An unreadable outcome is not "nothing pending": keep the suspension so
      // a retry of the same review still continues this dispatch.
      const pending = await readPending();
      if (pending) suspend(pending);
      else if (turn.setup.input.signal?.aborted || isAbortError(error)) settle({ state: 'interrupted' });
      else settle({ state: 'failed', error: error instanceof Error ? error.message : 'internal error' });
      throw error;
    }
    if (result.status === 'completed') {
      settle({ state: 'completed', reply: result.reply });
    } else if (result.status === 'waiting') {
      const read = pendingInterrupt ? null : (await turn.graphService.readThreadState(turn.setup)).pendingInterrupt;
      const pending = pendingInterrupt ?? (read ? projectPendingInterrupt(read) : null);
      if (!pending) throw new Error('A waiting dispatch has no pending interrupt.');
      suspend(pending);
    } else {
      const pending = await readPending();
      if (pending) suspend(pending);
      else settle({ state: 'interrupted' });
    }
    return result;
  };
}
