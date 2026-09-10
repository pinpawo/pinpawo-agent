import { randomUUID } from 'node:crypto';
import { HumanMessage } from '@langchain/core/messages';
import { interrupt } from '@langchain/langgraph';
import { setAgentMessageMetadata } from '../../../messages';
import { pauseTaskInterrupt } from '../../interrupt';
import type { OrchestratorStateType } from '../../state';

/** Native interrupt keeps this run and all checkpointed call identities. */
export async function pauseGate(state: OrchestratorStateType) {
  const resumed = pauseTaskInterrupt.resume(interrupt(pauseTaskInterrupt.interaction()));
  const guidance = resumed.guidance ? setAgentMessageMetadata(
    new HumanMessage({ id: randomUUID(), content: resumed.guidance }),
    { traceId: state.traceId, runId: state.runId },
  ) : null;
  return { ...(guidance ? { messages: [guidance] } : {}), taskPauseInterrupt: null };
}

export function afterPauseGate(_state: OrchestratorStateType) {
  return 'runSupervisor' as const;
}
