import { AIMessage, ToolMessage, type BaseMessage } from '@langchain/core/messages';
import { getAgentMessageMetadata, setAgentMessageMetadata } from '../agent/messages';
import { createCapabilityExecutionMessage, readCapabilityExecutionRecord } from '../agent/orchestrator/executionMessages';

/** Native Capability result fixture; pair it with a call before using as main history. */
export function createDeliveryResult(data: {
  id?: string; sourceLane: `capability:${string}`; delegationId: string; runId: string;
  deliveryId: string; task: string | null; result: string; createdAt: string;
}) {
  const task = data.task ?? 'Fixture task';
  const scope = { lane: data.sourceLane, delegationId: data.delegationId, runId: data.runId, taskId: data.runId };
  const message = createCapabilityExecutionMessage({
    callId: `call:${data.deliveryId}`,
    execution: { planItemId: data.delegationId, delegationId: data.delegationId, capability: data.sourceLane.slice(11), task, briefing: 'Fixture plan' },
    result: { status: 'returned', delivery: { id: data.deliveryId, task, text: data.result, scope }, artifacts: [] },
    metadata: { runId: data.runId, taskId: data.runId, createdAt: data.createdAt },
  });
  if (data.id) message.id = data.id;
  return message;
}

export function readFixtureDelivery(message: BaseMessage) {
  if (!ToolMessage.isInstance(message)) return null;
  const record = readCapabilityExecutionRecord(message);
  const delivery = record?.kind === 'executed' ? record.result.delivery : null;
  return delivery ? { result: delivery.text, task: delivery.task, deliveryId: delivery.id,
    sourceLane: delivery.scope.lane, runId: delivery.scope.runId, delegationId: delivery.scope.delegationId } : null;
}

/** Fill native request/result pairs in static fixtures, preserving existing calls. */
export function withDeliveryCalls(messages: BaseMessage[]): BaseMessage[] {
  const ids = new Set(messages.flatMap(m => AIMessage.isInstance(m) ? (m.tool_calls ?? []).map(c => c.id) : []));
  return messages.flatMap(message => {
    if (!ToolMessage.isInstance(message) || message.name !== 'delegate_capability' || ids.has(message.tool_call_id)) return [message];
    const request = setAgentMessageMetadata(new AIMessage({ id: `request:${message.id ?? message.tool_call_id}`, content: '',
      tool_calls: [{ id: message.tool_call_id, name: message.name, args: { briefing: 'Fixture plan' } }],
    }), getAgentMessageMetadata(message));
    return [request, message];
  });
}
