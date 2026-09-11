import { AIMessage, ToolMessage } from '@langchain/core/messages';
import { getAgentMessageMetadata, setAgentMessageMetadata } from '../../messages';
import type { OrchestratorStateType } from '../state';
import { capabilityHandoffSchema } from '../runSupervisor/protocol';
import type { CapabilityExecutionResult } from '../capabilityExecution/types';
import { currentSupervisorTask } from '../runSupervisor/state';

/** Read the actual checkpointed invocation, not a second pending-call register. */
export function readCapabilityCall(state: Pick<OrchestratorStateType, 'messages' | 'runId' | 'traceId' | 'runSupervisorState'>) {
  const message = state.messages.filter((message) => AIMessage.isInstance(message)
    && !getAgentMessageMetadata(message).lane
    && getAgentMessageMetadata(message).runId === state.runId
    && message.tool_calls?.some((call) => call.name === 'delegate_capability')).at(-1);
  if (!AIMessage.isInstance(message) || message.tool_calls?.length !== 1
    || getAgentMessageMetadata(message).traceId !== state.traceId) {
    throw Object.assign(new Error('This checkpoint has no compatible Capability execution call.'), { code: 'checkpoint_incompatible' });
  }
  const call = message.tool_calls[0];
  const args = capabilityHandoffSchema.parse(call.args);
  const current = currentSupervisorTask(state.runSupervisorState);
  if (!call.id || !current || current.id !== args.execution.taskId
    || current.capability !== args.execution.capability || current.task !== args.execution.task) {
    throw new Error('Capability call does not match the current plan task.');
  }
  if (state.messages.some((message) => ToolMessage.isInstance(message)
    && !getAgentMessageMetadata(message).lane && message.tool_call_id === call.id)) {
    throw new Error('Capability call already has a result.');
  }
  return { id: call.id, ...args.execution };
}

export function capabilityResultMessage(state: Pick<OrchestratorStateType, 'runId' | 'traceId'>,
  call: ReturnType<typeof readCapabilityCall>, result: Pick<CapabilityExecutionResult, 'status' | 'delivery' | 'artifacts'>) {
  return setAgentMessageMetadata(new ToolMessage({
    id: `delegation-result:${call.id}`, name: 'delegate_capability',
    status: result.status === 'missing_deliverable' ? 'error' : 'success',
    tool_call_id: call.id, content: JSON.stringify(result),
  }), { runId: state.runId, traceId: state.traceId, delegationId: call.delegationId,
    sourceCapability: call.capability, runtimeGenerated: true });
}
