import type { BaseMessage } from '@langchain/core/messages';
import { createOrchestratorMessageViews } from '../messageViews';

export function buildCapabilityPlannerMessageView(
  messages: readonly BaseMessage[],
  plannerInput: BaseMessage,
) {
  return createOrchestratorMessageViews(messages)
    .capabilityPlannerProvider(plannerInput);
}

/**
 * Build the canonical Planner conversation view. Every lane-tagged message and
 * invocation-only delegation briefing is excluded by the shared main query.
 * Accepted typed Announces are projected only in the returned provider input.
 */
export function projectCapabilityPlannerMessagesForModel(
  messages: readonly BaseMessage[],
): BaseMessage[] {
  return createOrchestratorMessageViews(messages)
    .capabilityPlannerHistory()
    .messages;
}
