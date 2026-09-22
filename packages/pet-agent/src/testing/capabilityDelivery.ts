import { AIMessage, ToolMessage, type BaseMessage } from '@langchain/core/messages';
import { getAgentMessageMetadata, setAgentMessageMetadata } from '../agent/messages';

/** Native Capability result fixture; pair it with a call before using as main history. */
export function createDeliveryResult(data: {
  id?: string; sourceLane: `capability:${string}`; delegationId: string; runId: string;
  deliveryId: string; task: string | null; result: string; createdAt: string;
}) {
  const task = data.task ?? 'Fixture task';
  const scope = { lane: data.sourceLane, delegationId: data.delegationId, runId: data.runId, taskId: data.runId };
  return setAgentMessageMetadata(new ToolMessage({ id: data.id, name: 'delegate_capability',
    tool_call_id: `call:${data.deliveryId}`, status: 'success',
    content: JSON.stringify({ status: 'returned', delivery: { id: data.deliveryId, task, text: data.result, scope } }),
    artifact: { planItemId: data.delegationId, delegationId: data.delegationId, capability: data.sourceLane.slice(11), task, briefing: 'Fixture plan' },
  }), { runId: data.runId, taskId: data.runId, createdAt: data.createdAt });
}

export function readFixtureDelivery(message: BaseMessage) {
  if (!ToolMessage.isInstance(message) || message.name !== 'delegate_capability') return null;
  try {
    const value = JSON.parse(message.text);
    if (!value.delivery) return null;
    const delivery = value.delivery;
    return { result: delivery.text as string, task: delivery.task as string,
      deliveryId: delivery.id as string, sourceLane: delivery.scope.lane as `capability:${string}`,
      runId: delivery.scope.runId as string, delegationId: delivery.scope.delegationId as string };
  } catch { return null; }
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
