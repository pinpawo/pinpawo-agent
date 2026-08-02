import { HumanMessage, type BaseMessage } from '@langchain/core/messages';
import {
  formatChatRequestDisplayText,
  type AgentLocalAttachment,
} from '@pinpawo/agent-session';
import { stampMessageCreatedAtUtc } from '@pinpawo/pet-agent';
import type {
  AdmittedLocalAttachment,
  AdmittedLocalImageAttachment,
} from './localImageAttachments';

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

export function createAdmittedLocalChatHumanMessage(
  message: string,
  attachments: readonly AdmittedLocalAttachment[],
) {
  const imageAttachments = attachments.filter(
    (attachment): attachment is AdmittedLocalImageAttachment => (
      attachment.source === 'local-image'
    ),
  );
  const fileAttachments = attachments.filter(
    (attachment): attachment is AgentLocalAttachment => (
      attachment.source === 'local-path'
    ),
  );
  const displayText = formatAdmittedChatRequestDisplayText(
    message,
    attachments,
  );
  const modelText = formatLocalChatModelText(message, fileAttachments);
  const content = imageAttachments.length
    ? [
        ...(modelText
          ? [{ type: 'text' as const, text: modelText }]
          : [{
              type: 'text' as const,
              text: `Attached image${imageAttachments.length === 1 ? '' : 's'}: ${
                imageAttachments.map(({ name }) => name).join(', ')
              }`,
            }]),
        ...imageAttachments.map(({ uri }) => ({
          type: 'image_url' as const,
          image_url: { url: uri },
        })),
      ]
    : modelText;
  const humanMessage = new HumanMessage({
    content,
    additional_kwargs: {
      pinpawo: {
        [DISPLAY_TEXT_METADATA_KEY]: displayText,
        ...(imageAttachments.length ? {
          localImages: imageAttachments.map((image) => ({
            name: image.name,
            mimeType: image.mimeType,
            byteSize: image.byteSize,
            sha256: image.sha256,
          })),
        } : {}),
      },
    },
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

function formatAdmittedChatRequestDisplayText(
  message: string,
  attachments: readonly AdmittedLocalAttachment[],
) {
  if (!attachments.length) return message;
  return [
    ...(message ? [message, ''] : []),
    'Attachments:',
    ...attachments.map((attachment) => (
      `- ${attachment.kind === 'directory'
        ? 'directory'
        : attachment.kind === 'image'
          ? 'image'
          : 'file'}: ${attachment.name}`
    )),
  ].join('\n');
}
