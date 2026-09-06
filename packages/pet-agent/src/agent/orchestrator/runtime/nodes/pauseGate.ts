import { HumanMessage } from '@langchain/core/messages';
import { interrupt } from '@langchain/langgraph';
import { pauseTaskInterrupt } from '../../interrupt';
import type { OrchestratorStateType } from '../../state';
import { applyActiveDelegationTransition } from '../activeDelegationTransition';

/**
 * EXPERIMENT (pause-as-interrupt).
 *
 * Suspends the root run on a task pause as a real LangGraph `interrupt()`, so
 * the pause is visible in `tasks[].interrupts[]` with an id and is continued
 * by id — the same mechanism ReviewInterrupt uses. The capability node has
 * already committed `taskActiveDelegation: pending` and `taskPauseInterrupt`
 * before this node runs, so only this node replays on resume.
 *
 * On resume the continue command is parsed by `PauseTaskInterrupt.resume()`
 * (its first real caller), optional guidance becomes one Runtime-created
 * message, and the delegation is re-entered through the same transition the
 * legacy `resume_active` turn used.
 */
export async function pauseGate(state: OrchestratorStateType) {
  const resumed = pauseTaskInterrupt.resume(interrupt(pauseTaskInterrupt.interaction()));
  const guidanceMessage = resumed.guidance ? new HumanMessage(resumed.guidance) : null;
  const transition = applyActiveDelegationTransition({
    ...state,
    ...(guidanceMessage ? { messages: [...state.messages, guidanceMessage] } : {}),
    runActiveDelegationTransition: 'resume_active',
  });
  return {
    ...transition,
    ...(guidanceMessage ? { messages: [guidanceMessage] } : {}),
    taskPauseInterrupt: null,
    runActiveDelegationTransition: 'resume_active' as const,
  };
}

export function afterPauseGate(state: OrchestratorStateType) {
  return state.runNextDelegation
    && state.runNextDelegation.id === state.taskActiveDelegation?.id
    ? 'capability'
    : 'answer';
}
