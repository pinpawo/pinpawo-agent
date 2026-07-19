import type { BaseMessage } from '@langchain/core/messages';
import { mainConversationMessages } from '../messageLanes';
import { readMessageText } from '../utils';

const MAX_REVIEW_USER_REQUESTS = 2;

export function selectReviewUserRequests(messages: BaseMessage[]) {
  return mainConversationMessages(messages)
    .filter((message) => message._getType() === 'human')
    .map((message) => readMessageText(message))
    .filter(Boolean)
    .slice(-MAX_REVIEW_USER_REQUESTS);
}
