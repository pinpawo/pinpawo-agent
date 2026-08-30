import type { BaseMessage } from '@langchain/core/messages';
import { readMessageText } from './utils';

export function readLatestHumanRequest(messages: readonly BaseMessage[]): string | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]!;
    if (message._getType() !== 'human') continue;
    const text = readMessageText(message);
    if (text) return text;
  }
  return null;
}
