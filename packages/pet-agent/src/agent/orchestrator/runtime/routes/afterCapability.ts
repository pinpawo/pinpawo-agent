import { END } from '@langchain/langgraph';
import type { OrchestratorStateType } from '../../state';
import { readCapabilityExecutions } from '../../executionMessages';

export function afterCapability(state: OrchestratorStateType) {
  const latest = readCapabilityExecutions(state.messages)
    .filter(({ metadata }) => metadata.runId === state.runId && metadata.taskId === state.taskId).at(-1);
  return latest?.result?.reviewDecision ? END : 'runSupervisor';
}
