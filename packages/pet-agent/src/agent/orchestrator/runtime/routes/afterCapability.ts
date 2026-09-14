import { ToolMessage } from '@langchain/core/messages';
import type { OrchestratorStateType } from '../../state';
import { readCapabilityExecutions } from '../../executionMessages';

export function afterCapability(state: OrchestratorStateType) {
  const latest = readCapabilityExecutions(state.messages)
    .filter(({ metadata }) => metadata.runId === state.runId && metadata.traceId === state.traceId).at(-1);
  const last = state.messages.at(-1);
  return ToolMessage.isInstance(last) && last.tool_call_id === latest?.call.id && latest?.result?.status === 'paused' ? 'pauseGate' : 'runSupervisor';
}
