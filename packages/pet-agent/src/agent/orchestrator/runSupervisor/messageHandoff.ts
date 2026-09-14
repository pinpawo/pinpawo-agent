import { AIMessage, ToolMessage, type BaseMessage } from '@langchain/core/messages';
import { setAgentMessageMetadata } from '../../messages';
import { identity, type SupervisorHandoffContext } from './controlContext';

/** Select the main delegation request and preserve private Supervisor work. */
export function supervisorWorkMessages(context: SupervisorHandoffContext, messages: readonly BaseMessage[]) {
  return messages.map((message, index) => {
    const copy = AIMessage.isInstance(message) ? new AIMessage({ ...message })
      : ToolMessage.isInstance(message) ? new ToolMessage({ ...message }) : message;
    const dispatch = index === messages.length - 1 && AIMessage.isInstance(copy)
      && copy.tool_calls?.length === 1 && copy.tool_calls[0].name === 'delegate_capability';
    // Provider IDs may repeat across runs; namespace messages, never rewrite tool call IDs or args.
    copy.id = identity('supervisor-message', context.runId, message.id ?? (ToolMessage.isInstance(message) ? message.tool_call_id : String(index)));
    return setAgentMessageMetadata(copy, { lane: dispatch ? undefined : 'supervisor',
      runId: context.runId, traceId: context.traceId, ...(dispatch ? { source: 'supervisor' } : {}) });
  });
}
