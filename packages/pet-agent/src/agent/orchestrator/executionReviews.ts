import { assertToolDeliverables, type Deliverable } from '@pinpawo/agent-contracts';
import { AIMessage, ToolMessage, type BaseMessage } from '@langchain/core/messages';
import { getAgentMessageMetadata } from '../messages';

/** Read self-contained acceptance results already recorded by this run's Supervisor. */
export function readAcceptedRunDeliverables(messages: readonly BaseMessage[], runId: string): Deliverable[] {
  const calls = new Map<string, string>();
  const uris = new Set<string>();
  const references: Deliverable[] = [];
  for (const message of messages) {
    const metadata = getAgentMessageMetadata(message);
    if (metadata.runId !== runId || metadata.lane !== 'supervisor' || metadata.synthetic
      || typeof metadata.taskId !== 'string' || !metadata.taskId) continue;
    if (AIMessage.isInstance(message)) {
      const call = message.tool_calls?.length === 1 ? message.tool_calls[0] : undefined;
      if (call?.name === 'review_current' && call.id && call.args.completed === true) {
        calls.set(call.id, metadata.taskId);
      }
      continue;
    }
    if (!ToolMessage.isInstance(message) || message.name !== 'review_current'
      || calls.get(message.tool_call_id) !== metadata.taskId) continue;
    calls.delete(message.tool_call_id);
    if (message.status === 'error' || !message.artifact || typeof message.artifact !== 'object'
      || !Object.hasOwn(message.artifact, 'acceptedExecution')) continue;
    const accepted = message.artifact.acceptedExecution;
    if (!accepted || typeof accepted !== 'object' || typeof accepted.delegationId !== 'string'
      || !accepted.delegationId.trim()) throw new Error('Corrupted review_current acceptance projection.');
    assertToolDeliverables(accepted);
    for (const reference of accepted.deliverables) {
      if (uris.has(reference.uri)) continue;
      uris.add(reference.uri);
      references.push({ ...reference });
    }
  }
  return references;
}
