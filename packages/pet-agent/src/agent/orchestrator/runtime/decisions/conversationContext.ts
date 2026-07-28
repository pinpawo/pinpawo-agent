import type { BaseMessage } from '@langchain/core/messages';
import { isContextCompactionMessage } from '../../contextCompaction';
import { mainConversationMessages } from '../../messageLanes';

export function mainMessagesWithoutCompaction(messages: BaseMessage[]): BaseMessage[] {
  return mainConversationMessages(messages)
    .filter((message) => !isContextCompactionMessage(message));
}
