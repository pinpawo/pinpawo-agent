import { AIMessage, ToolMessage, type BaseMessage } from '@langchain/core/messages';
import { z } from 'zod';
import { getAgentMessageMetadata } from '../messages';
import { capabilityHandoffSchema } from './runSupervisor/protocol';

const resultSchema = z.object({
  status: z.enum(['returned', 'paused', 'missing_deliverable']),
  delivery: z.object({
    id: z.string().min(1), task: z.string(), text: z.string().refine((text) => text.trim().length > 0),
    scope: z.object({
      lane: z.string().refine((lane): lane is `capability:${string}` => lane.startsWith('capability:')),
      runId: z.string().min(1), traceId: z.string().min(1), delegationId: z.string().min(1),
    }),
  }).nullable(),
});

/** A read-only view of actual Root tool pairs, never a second execution register. */
export function readCapabilityExecutions(messages: readonly unknown[]) {
  const results = new Map<string, ToolMessage>();
  for (const message of messages) {
    if (message && ToolMessage.isInstance(message as BaseMessage)
      && !getAgentMessageMetadata(message as BaseMessage).lane
      && (message as ToolMessage).name === 'delegate_capability') {
      results.set((message as ToolMessage).tool_call_id, message as ToolMessage);
    }
  }
  return messages.flatMap((value) => {
    if (!value || !AIMessage.isInstance(value as BaseMessage)) return [];
    const message = value as AIMessage;
    const metadata = getAgentMessageMetadata(message);
    if (metadata.lane || !metadata.runId || !metadata.traceId) return [];
    return (message.tool_calls ?? []).flatMap((call) => {
      if (call.name !== 'delegate_capability' || !call.id) return [];
      const parsed = capabilityHandoffSchema.safeParse(call.args);
      if (!parsed.success) return [];
      const execution = parsed.data.execution;
      const resultMessage = results.get(call.id);
      let result: z.infer<typeof resultSchema> | null = null;
      if (resultMessage && typeof resultMessage.content === 'string') {
        try {
          const data = resultSchema.safeParse(JSON.parse(resultMessage.content));
          const resultMetadata = getAgentMessageMetadata(resultMessage);
          if (data.success && resultMetadata.runId === metadata.runId && resultMetadata.traceId === metadata.traceId) {
            const delivery = data.data.delivery;
            if ((!delivery || (delivery.scope.runId === metadata.runId && delivery.scope.traceId === metadata.traceId
              && delivery.scope.delegationId === execution.delegationId
              && delivery.scope.lane === `capability:${execution.capability}`))
              && !(data.data.status === 'returned' && resultMessage.status === 'error')) result = data.data;
          }
        } catch { /* Malformed results cannot serve as acceptance evidence. */ }
      }
      return [{ call, metadata, execution, result }];
    });
  });
}

export function executionsForTask(context: { messages: readonly BaseMessage[] }, taskId: string) {
  return readCapabilityExecutions(context.messages).filter(({ execution }) => execution.taskId === taskId);
}

export function readDelegationDeliveries(messages: readonly unknown[]) {
  return readCapabilityExecutions(messages).flatMap(({ result }) => result?.delivery ? [result.delivery] : []);
}
