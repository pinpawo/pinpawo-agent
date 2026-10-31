import type { BaseMessage } from '@langchain/core/messages';

/**
 * UI override for local user input whose model content includes attachment
 * details. Transcript projection prefers this metadata; model invocation uses
 * message.content. The key is retained for persisted checkpoints.
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
