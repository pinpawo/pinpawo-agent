import { AIMessage, ToolMessage, type BaseMessage } from '@langchain/core/messages';
import { z } from 'zod';
import { getAgentMessageMetadata, setAgentMessageMetadata, type AgentMessageMetadata } from '../messages';
import { capabilityExecutionSnapshotSchema, type CapabilityExecutionInput } from './runSupervisor/protocol';

export const DELEGATE_CAPABILITY_TOOL_NAME = 'delegate_capability';

const executionResultSchema = z.object({
  status: z.enum(['returned', 'missing_deliverable']),
  reviewDecision: z.enum(['reject', 'cancel']).optional(),
  delivery: z.object({
    id: z.string().min(1), task: z.string(), text: z.string().refine((text) => text.trim().length > 0),
    scope: z.object({
      lane: z.string().refine((lane): lane is `capability:${string}` => lane.startsWith('capability:')),
      runId: z.string().min(1), taskId: z.string().min(1), delegationId: z.string().min(1),
    }).strict(),
  }).strict().nullable(),
  artifacts: z.array(z.record(z.string(), z.unknown())),
}).strict().refine(result => !result.reviewDecision
  || (result.status === 'missing_deliverable' && result.delivery === null), {
  message: 'A declined review cannot be a returned delivery.',
});

/**
 * The typed record a delegate_capability result carries in its artifact. The
 * content is only the model-facing rendering of `result`; readers never parse it.
 * `rejected` marks a call refused before execution (a correctable decision error).
 */
const executionRecordSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('executed'), execution: capabilityExecutionSnapshotSchema, result: executionResultSchema }).strict(),
  z.object({ kind: z.literal('rejected') }).strict(),
]);

export type CapabilityExecutionResultRecord = z.infer<typeof executionResultSchema>;
export type CapabilityExecutionRecord = z.infer<typeof executionRecordSchema>;

/** The one writer of an executed delegation result, shared by the tool and fixtures. */
export function createCapabilityExecutionMessage(params: {
  callId: string;
  execution: CapabilityExecutionInput;
  result: CapabilityExecutionResultRecord;
  metadata: AgentMessageMetadata;
}): ToolMessage {
  const record: CapabilityExecutionRecord = { kind: 'executed', execution: params.execution, result: params.result };
  const message = new ToolMessage({
    name: DELEGATE_CAPABILITY_TOOL_NAME, tool_call_id: params.callId,
    status: params.result.status === 'missing_deliverable' ? 'error' : 'success',
    content: JSON.stringify(params.result),
    artifact: record,
  });
  setAgentMessageMetadata(message, params.metadata);
  return message;
}

/** A delegation refused before execution; the content is feedback for the model. */
export function createRejectedCapabilityExecutionMessage(params: {
  callId: string;
  content: string;
  metadata: AgentMessageMetadata;
}): ToolMessage {
  const record: CapabilityExecutionRecord = { kind: 'rejected' };
  const message = new ToolMessage({
    name: DELEGATE_CAPABILITY_TOOL_NAME, tool_call_id: params.callId, status: 'error',
    content: params.content, artifact: record,
  });
  setAgentMessageMetadata(message, params.metadata);
  return message;
}

/** The typed record of a delegate_capability result, or null for other messages. */
export function readCapabilityExecutionRecord(message: ToolMessage): CapabilityExecutionRecord | null {
  if (message.name !== DELEGATE_CAPABILITY_TOOL_NAME) return null;
  const parsed = executionRecordSchema.safeParse(message.artifact);
  if (!parsed.success) corrupted(message, 'artifact is not an execution record');
  return parsed.data;
}

/** Read native tool-call identity; execution data lives in the actual tool result artifact. */
export function readCapabilityExecutionCall(message: BaseMessage) {
  if (!AIMessage.isInstance(message) || message.tool_calls?.length !== 1) return null;
  const metadata = getAgentMessageMetadata(message);
  const call = message.tool_calls[0];
  if (metadata.lane || !metadata.runId || !metadata.taskId || call.name !== DELEGATE_CAPABILITY_TOOL_NAME || !call.id) return null;
  return { call, metadata };
}

function corrupted(resultMessage: ToolMessage, reason: string): never {
  throw new Error(`Corrupted ${DELEGATE_CAPABILITY_TOOL_NAME} record for call ${resultMessage.tool_call_id}: ${reason}.`);
}

/**
 * A read-only view of actual Root tool pairs, never a second execution register.
 * Records are runtime-written, so an inconsistent one is an invariant violation,
 * not missing evidence. Calls without a result yet, and rejected calls, are not
 * executions.
 */
export function readCapabilityExecutions(messages: readonly unknown[]) {
  const results = new Map<string, ToolMessage>();
  for (const message of messages) {
    if (message && ToolMessage.isInstance(message as BaseMessage)
      && !getAgentMessageMetadata(message as BaseMessage).lane
      && (message as ToolMessage).name === DELEGATE_CAPABILITY_TOOL_NAME) {
      results.set(`${getAgentMessageMetadata(message as BaseMessage).runId}:${(message as ToolMessage).tool_call_id}`, message as ToolMessage);
    }
  }
  return messages.flatMap((value) => {
    if (!value || !AIMessage.isInstance(value as BaseMessage)) return [];
    const invocation = readCapabilityExecutionCall(value as AIMessage);
    if (!invocation) return [];
    const { call, metadata } = invocation;
    const resultMessage = results.get(`${metadata.runId}:${call.id}`);
    if (!resultMessage) return [];
    const record = readCapabilityExecutionRecord(resultMessage)!;
    if (record.kind === 'rejected') return [];
    const { execution, result } = record;
    if (getAgentMessageMetadata(resultMessage).taskId !== metadata.taskId) corrupted(resultMessage, 'task does not match its call');
    if ((resultMessage.status === 'error') !== (result.status === 'missing_deliverable')) {
      corrupted(resultMessage, `message status ${resultMessage.status ?? 'success'} contradicts ${result.status}`);
    }
    const scope = result.delivery?.scope;
    if (scope && (scope.runId !== metadata.runId || scope.taskId !== metadata.taskId
      || scope.delegationId !== execution.delegationId || scope.lane !== `capability:${execution.capability}`)) {
      corrupted(resultMessage, 'delivery scope does not match its delegation');
    }
    return [{ call, metadata, execution, result }];
  });
}

export function executionsForPlanItem(context: { messages: readonly BaseMessage[] }, planItemId: string) {
  return readCapabilityExecutions(context.messages).filter(({ execution }) => execution.planItemId === planItemId);
}

export function readDelegationDeliveries(messages: readonly unknown[]) {
  return readCapabilityExecutions(messages).flatMap(({ result }) => result.delivery ? [result.delivery] : []);
}
