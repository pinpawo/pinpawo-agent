import type { BaseMessage } from '@langchain/core/messages';
import { queryAgentMessages, toolProtocolSafeMessages } from '../../messages';
import { projectDelegationAnnouncesForModel } from '../delegation';

export function buildCapabilityPlannerProviderMessages(
  messages: readonly BaseMessage[],
  plannerInput: BaseMessage,
) {
  const mainMessages = queryAgentMessages(messages).main().select().messages;
  return toolProtocolSafeMessages([
    ...projectDelegationAnnouncesForModel(mainMessages),
    plannerInput,
  ]);
}

/**
 * Project typed Announces at the Planner provider boundary. The caller passes
 * canonical main messages selected from Orchestrator state.
 */
export function projectCapabilityPlannerMessagesForModel(
  messages: readonly BaseMessage[],
): BaseMessage[] {
  const mainMessages = queryAgentMessages(messages).main().select().messages;
  return toolProtocolSafeMessages(projectDelegationAnnouncesForModel(mainMessages));
}
