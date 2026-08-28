import type { BaseMessage } from '@langchain/core/messages';
import { projectDelegationAnnouncesForModel } from '../delegationAnnounce';
import { mainConversationMessages, toolProtocolSafeMessages } from '../messageLanes';

/**
 * Build the canonical Planner conversation view. Every lane-tagged message and
 * invocation-only delegation briefing is excluded by mainConversationMessages.
 * Accepted typed Announces are projected only in the returned provider input.
 */
export function projectCapabilityPlannerMessagesForModel(
  messages: readonly BaseMessage[],
): BaseMessage[] {
  return projectDelegationAnnouncesForModel(toolProtocolSafeMessages(
    mainConversationMessages([...messages]),
  ));
}
