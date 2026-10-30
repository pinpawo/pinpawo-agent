import { AIMessage, type BaseMessage } from '@langchain/core/messages';
import { readMessageText } from '@pinpawo/pet-agent';

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

/** Read normalized public AI text without exposing reasoning or tool data. */
export function readPublicMessageText(message: BaseMessage): string {
  if (!AIMessage.isInstance(message)) return readMessageText(message);
  if (Array.isArray(message.content) && message.content.some(part =>
    typeof part === 'string' || (part && typeof part === 'object' && !('type' in part) && 'text' in part))) {
    // Core's standardized text getter currently drops legacy string/untyped blocks.
    // Preserve that shape's existing spacing, but do not surface non-text blocks.
    const parts = (message.contentBlocks as unknown[]).map((part) => {
      if (typeof part === 'string') return part;
      if (part && typeof part === 'object' && (!('type' in part) || part.type === 'text')) return part;
      return '';
    });
    return readMessageText({ content: parts });
  }
  return message.text.trim();
}
