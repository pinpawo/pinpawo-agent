import type { OrchestratorStateType } from '../../state';
import { readCapabilityExecutions } from '../../executionMessages';

export function afterCapability(state: OrchestratorStateType) {
  const latest = readCapabilityExecutions(state.messages)
    .filter(({ metadata }) => metadata.runId === state.runId && metadata.traceId === state.traceId).at(-1);
  return latest?.result?.status === 'paused' ? 'pauseGate' : 'runSupervisor';
}
