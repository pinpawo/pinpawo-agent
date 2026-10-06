import { AIMessage, ToolMessage, type BaseMessage } from '@langchain/core/messages';
import { setAgentMessageMetadata } from '../../messages';
import { identity, type SupervisorControlContext } from './controlContext';
import { capabilityDetailsWorkRecord } from './detailsTool';
import type { SupervisorPlanItem } from './state';

/**
 * Select the main delegation request and preserve private Supervisor work.
 *
 * `dispatching` is the caller's own fact — the delegation branch knows it is
 * dispatching, and the reply branch knows it is not — rather than something
 * re-derived from the shape of the last message. Only the final message of a
 * dispatching batch carries the request into main, together with the plan item
 * it delegates so observers can announce the work before it runs.
 */
export function supervisorWorkMessages(
  context: SupervisorControlContext,
  messages: readonly BaseMessage[],
  dispatching = false,
  task?: SupervisorPlanItem | null,
) {
  return messages.map((message, index) => {
    const copy = AIMessage.isInstance(message) ? new AIMessage({ ...message })
      : ToolMessage.isInstance(message) ? capabilityDetailsWorkRecord(new ToolMessage({ ...message })) : message;
    const dispatch = dispatching && index === messages.length - 1
      && AIMessage.isInstance(copy) && Boolean(copy.tool_calls?.length);
    // Root history spans runs; native ToolNode requires globally distinct call IDs.
    if (dispatch) copy.tool_calls = copy.tool_calls!.map(call => ({ ...call, id: identity('call', context.runId, call.id!) }));
    copy.id = identity('supervisor-message', context.runId, message.id ?? (ToolMessage.isInstance(message) ? message.tool_call_id : String(index)));
    return setAgentMessageMetadata(copy, { lane: dispatch ? undefined : 'supervisor',
      runId: context.runId, taskId: context.taskId, ...(dispatch ? { source: 'supervisor' } : {}),
      ...(dispatch && task ? { delegationPreview: { planItemId: task.id, capability: task.capability, objective: task.objective } } : {}) });
  });
}
