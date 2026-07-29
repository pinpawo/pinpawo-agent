import { HumanMessage, type BaseMessage } from '@langchain/core/messages';
import {
  formatChatRequestDisplayText,
  type AgentLocalAttachment,
} from '@pinpawo/agent-session';
import { stampMessageCreatedAtUtc } from '@pinpawo/pet-agent';

const DISPLAY_TEXT_METADATA_KEY = 'localChatDisplayText';

export function createLocalChatHumanMessage(
  message: string,
  attachments: readonly AgentLocalAttachment[] = [],
) {
  const displayText = formatChatRequestDisplayText(message, attachments);
  const humanMessage = new HumanMessage({
    content: formatLocalChatModelText(message, attachments),
    ...(attachments.length
      ? {
          additional_kwargs: {
            pinpawo: {
              [DISPLAY_TEXT_METADATA_KEY]: displayText,
            },
          },
        }
      : {}),
  });
  return stampMessageCreatedAtUtc(humanMessage);
}

export function readLocalChatDisplayText(message: BaseMessage) {
  const pinpawo = message.additional_kwargs?.pinpawo;
  if (!pinpawo || typeof pinpawo !== 'object') return null;
  const displayText = (pinpawo as Record<string, unknown>)[DISPLAY_TEXT_METADATA_KEY];
  return typeof displayText === 'string' && displayText.trim()
    ? displayText
    : null;
}

export function formatLocalChatModelText(
  message: string,
  attachments: readonly AgentLocalAttachment[] = [],
) {
  if (!attachments.length) return message;
  const localPaths = attachments.map(({ kind, name, path }) => ({
    kind,
    name,
    path,
  }));
  return [
    ...(message ? [message, ''] : []),
    '<local_attachments>',
    JSON.stringify(localPaths, null, 2),
    '</local_attachments>',
    'These are local filesystem references supplied by the user. Use local tools to inspect them; do not assume their contents.',
  ].join('\n');
}
