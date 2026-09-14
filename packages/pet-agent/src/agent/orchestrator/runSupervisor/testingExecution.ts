import { AIMessage, ToolMessage } from '@langchain/core/messages';
import { getAgentMessageMetadata } from '../../messages';
import type { OrchestratorStateType } from '../state';
import { readCapabilityExecutionCall } from '../executionMessages';
import { identity } from './controlContext';
import { readCapabilityExecutions } from '../executionMessages';
import { currentSupervisorTask } from './state';

/** Read the actual checkpointed invocation, not a second pending-call register. */
export function readCapabilityCall(state: Pick<OrchestratorStateType, 'messages' | 'runId' | 'traceId' | 'runSupervisorState'> & { runSupervisorReviewFeedback?: string | null }) {
  const message = state.messages.filter((message) => AIMessage.isInstance(message)
    && !getAgentMessageMetadata(message).lane
    && getAgentMessageMetadata(message).runId === state.runId
    && message.tool_calls?.some((call) => call.name === 'delegate_capability')).at(-1);
  if (!AIMessage.isInstance(message) || message.tool_calls?.length !== 1
    || getAgentMessageMetadata(message).traceId !== state.traceId) {
    throw Object.assign(new Error('This checkpoint has no compatible Capability execution call.'), { code: 'checkpoint_incompatible' });
  }
  const call = message.tool_calls[0];
  const invocation = readCapabilityExecutionCall(message);
  if (!invocation) throw Object.assign(new Error('This checkpoint has no compatible Capability execution call.'), { code: 'checkpoint_incompatible' });
  const current = currentSupervisorTask(state.runSupervisorState);
  if (!call.id || !current) throw new Error('Capability call has no current plan task.');
  if (state.messages.some((message) => ToolMessage.isInstance(message)
    && !getAgentMessageMetadata(message).lane && message.tool_call_id === call.id)) {
    throw new Error('Capability call already has a result.');
  }
  const previous = readCapabilityExecutions(state.messages)
    .filter(record => record.metadata.runId === state.runId && record.execution.taskId === current.id).at(-1);
  return { id: call.id, taskId: current.id, task: current.task, capability: current.capability,
    delegationId: previous?.execution.delegationId ?? identity('delegation', state.runId, current.id),
    mode: previous ? 'continue' as const : 'initial' as const,
    briefing: JSON.stringify({ plan: state.runSupervisorState.plan.map(({ capability, task, status }) => ({ capability, task, status })),
      ...(state.runSupervisorReviewFeedback ? { feedback: state.runSupervisorReviewFeedback } : {}) }) };

}

