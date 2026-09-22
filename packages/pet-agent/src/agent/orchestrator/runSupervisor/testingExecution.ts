import { AIMessage, ToolMessage } from '@langchain/core/messages';
import { getAgentMessageMetadata } from '../../messages';
import type { OrchestratorStateType } from '../state';
import { readCapabilityExecutionCall } from '../executionMessages';
import { buildCapabilityExecutionInput, delegateCapabilitySchema } from './delegateCapabilityTool';
import { currentSupervisorTask } from './state';

/** Read the actual checkpointed invocation, not a second pending-call register. */
export function readCapabilityCall(state: Pick<OrchestratorStateType, 'messages' | 'runId' | 'taskId' | 'runSupervisorState'>) {
  const message = state.messages.filter((message) => AIMessage.isInstance(message)
    && !getAgentMessageMetadata(message).lane
    && getAgentMessageMetadata(message).runId === state.runId
    && message.tool_calls?.some((call) => call.name === 'delegate_capability')).at(-1);
  if (!AIMessage.isInstance(message) || message.tool_calls?.length !== 1
    || getAgentMessageMetadata(message).taskId !== state.taskId) {
    throw new Error('Expected a current Capability tool call.');
  }
  const call = message.tool_calls[0];
  const invocation = readCapabilityExecutionCall(message);
  if (!invocation) throw new Error('Expected a current Capability tool call.');
  const current = currentSupervisorTask(state.runSupervisorState);
  if (!call.id || !current) throw new Error('Capability call has no current plan task.');
  if (state.messages.some((message) => ToolMessage.isInstance(message)
    && !getAgentMessageMetadata(message).lane && message.tool_call_id === call.id)) {
    throw new Error('Capability call already has a result.');
  }
  return { id: call.id, ...buildCapabilityExecutionInput({
    state: state.runSupervisorState, messages: state.messages, runId: state.runId, taskId: state.taskId,
    userRequest: state.runSupervisorState.goal!, mode: 'boundary', hasNewUserInput: false,
    allowedCapabilityNames: state.runSupervisorState.plan.map(task => task.capability),
  }, delegateCapabilitySchema.parse(call.args), call.id) };
}
