import { randomUUID } from 'node:crypto';
import { HumanMessage } from '@langchain/core/messages';
import { interrupt } from '@langchain/langgraph';
import { setAgentMessageMetadata } from '../../../messages';
import { pauseTaskInterrupt } from '../../interrupt';
import type { OrchestratorStateType } from '../../state';
import { applyActiveDelegationTransition } from '../activeDelegationTransition';

/** Resume by interrupt id. New guidance goes to Supervisor before any work. */
export async function pauseGate(state: OrchestratorStateType) {
  const resumed = pauseTaskInterrupt.resume(interrupt(pauseTaskInterrupt.interaction()));
  const guidanceMessage = resumed.guidance ? setAgentMessageMetadata(
    new HumanMessage({ id: randomUUID(), content: resumed.guidance }),
    { traceId: state.taskActiveDelegation?.traceId ?? state.traceId, runId: state.runId },
  ) : null;
  const transition = applyActiveDelegationTransition({
    ...state,
    ...(guidanceMessage ? { messages: [...state.messages, guidanceMessage] } : {}),
    runActiveDelegationTransition: 'resume_active',
  }, { deferExecution: Boolean(guidanceMessage) });
  return {
    ...transition,
    ...(guidanceMessage ? { messages: [guidanceMessage] } : {}),
    taskPauseInterrupt: null,
    runSupervisorUserMessageId: guidanceMessage?.id ?? null,
    runActiveDelegationTransition: 'resume_active' as const,
  };
}

export function afterPauseGate(state: OrchestratorStateType) {
  if (state.runSupervisorUserMessageId && state.taskActiveDelegation && !state.runRuntimeFailure) return 'runSupervisor';
  return state.runNextDelegation
    && state.runNextDelegation.id === state.taskActiveDelegation?.id
    ? 'runSupervisor'
    : 'answer';
}
