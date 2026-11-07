import { AIMessage, type BaseMessage } from '@langchain/core/messages';
import { parseDeliverables, type Deliverable } from '@pinpawo/agent-contracts';
import { readCapabilityExecutions } from './executionMessages';
import type { RunSupervisorState } from './runSupervisor/state';

/** Select the same latest execution that review_current accepted for each item. */
export function selectReplyDeliverables(
  messages: readonly BaseMessage[],
  plan: RunSupervisorState,
  runId: string,
): Deliverable[] {
  if (plan.runId !== runId) return [];
  const completed = new Set(plan.plan.filter(item => item.status === 'completed').map(item => item.id));
  const executions = readCapabilityExecutions(messages).filter(record => record.metadata.runId === runId
    && completed.has(record.execution.planItemId));
  const latest = new Map(executions.map(record => [record.execution.planItemId, record]));
  return executions.flatMap(record => latest.get(record.execution.planItemId) === record
    && record.result.status === 'returned' ? record.result.deliverables ?? [] : [])
    .filter((reference, index, references) => references.findIndex(other => other.uri === reference.uri) === index);
}

/** A reply owns its selected references, so historical projection needs no current plan. */
export function readReplyDeliverables(reply: BaseMessage | null | undefined): Deliverable[] {
  const declarations = reply?.additional_kwargs?.deliverables;
  return declarations === undefined ? [] : parseDeliverables(declarations);
}

/** Capture the existing plan's acceptance facts at each public reply exit. */
export function withReplyDeliverables(
  reply: AIMessage,
  messages: readonly BaseMessage[],
  plan: RunSupervisorState,
  runId: string,
): AIMessage {
  const deliverables = selectReplyDeliverables(messages, plan, runId);
  const { deliverables: _modelDeclarations, ...additionalKwargs } = reply.additional_kwargs;
  return new AIMessage({ ...reply,
    additional_kwargs: { ...additionalKwargs, ...(deliverables.length ? { deliverables } : {}) },
  });
}
