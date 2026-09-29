import type { BaseMessage } from '@langchain/core/messages';

/**
 * Where a message carries the text the interface should show, as opposed to
 * the text the model was given. Written when the execution input is built,
 * read back here for display.
 */
export const DISPLAY_TEXT_METADATA_KEY = 'localChatDisplayText';

export function readLocalChatDisplayText(message: BaseMessage) {
  const pinpawo = message.additional_kwargs?.pinpawo;
  if (!pinpawo || typeof pinpawo !== 'object') return null;
  const displayText = (pinpawo as Record<string, unknown>)[DISPLAY_TEXT_METADATA_KEY];
  return typeof displayText === 'string' && displayText.trim()
    ? displayText
    : null;
}
