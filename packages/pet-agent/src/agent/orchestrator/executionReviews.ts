import { AIMessage, ToolMessage, type BaseMessage } from '@langchain/core/messages';
import type { Deliverable } from '@pinpawo/agent-contracts';
import { getAgentMessageMetadata } from '../messages';
import { readCapabilityExecutions } from './executionMessages';

/** Read acceptance facts from successful, paired Supervisor review results. */
export function readAcceptedRunDeliverables(messages: readonly BaseMessage[], runId: string): Deliverable[] {
  const calls = new Set<string>();
  const accepted = new Set<string>();
  for (const message of messages) {
    const metadata = getAgentMessageMetadata(message);
    if (metadata.runId !== runId || metadata.lane !== 'supervisor') continue;
    if (AIMessage.isInstance(message)) {
      for (const call of message.tool_calls ?? []) {
        if (call.name === 'review_current' && call.args.completed === true && call.id) calls.add(call.id);
      }
    } else if (ToolMessage.isInstance(message) && message.name === 'review_current'
      && message.status !== 'error' && calls.has(message.tool_call_id)) {
      const artifact = message.artifact;
      if (artifact && typeof artifact === 'object' && 'acceptedDelegationId' in artifact
        && typeof artifact.acceptedDelegationId === 'string') accepted.add(artifact.acceptedDelegationId);
    }
  }
  const seen = new Set<string>();
  return readCapabilityExecutions(messages).flatMap(({ execution, result }) =>
    accepted.has(execution.delegationId) && result.status === 'returned'
      ? result.deliverables.filter(reference => {
          if (seen.has(reference.uri)) return false;
          seen.add(reference.uri);
          return true;
        }).map(reference => ({ ...reference }))
      : []);
}
