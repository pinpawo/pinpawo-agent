import type { BaseMessage } from '@langchain/core/messages';
import { laneMessages, mainConversationMessages } from '../messageLanes';
import type { MessageLane } from '../types';

export type CapabilityPlannerMessageContext = {
  readonly scope: 'main_conversation' | 'active_delegation';
  readonly messages: readonly BaseMessage[];
};

export function selectCapabilityPlannerMessages(params: {
  mode: 'entry';
  messages: readonly BaseMessage[];
} | {
  mode: 'boundary';
  messages: readonly BaseMessage[];
  lane: MessageLane;
  transcriptRunId: string;
  delegationId: string;
}): CapabilityPlannerMessageContext {
  if (params.mode === 'entry') {
    const mainMessages = mainConversationMessages([...params.messages]);
    let currentRequestIndex = -1;
    for (let index = mainMessages.length - 1; index >= 0; index -= 1) {
      if (mainMessages[index]?._getType() === 'human') {
        currentRequestIndex = index;
        break;
      }
    }
    return {
      scope: 'main_conversation',
      messages: currentRequestIndex >= 0
        ? mainMessages.slice(0, currentRequestIndex + 1)
        : mainMessages,
    };
  }
  return {
    scope: 'active_delegation',
    messages: laneMessages(
      [...params.messages],
      params.lane,
      params.transcriptRunId,
      params.delegationId,
    ),
  };
}
