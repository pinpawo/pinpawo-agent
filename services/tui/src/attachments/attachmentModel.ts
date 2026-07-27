import {
  AGENT_LOCAL_ATTACHMENT_LIMIT,
  formatChatRequestDisplayText,
  type AgentLocalAttachment,
} from '@pinpawo/agent-session';

export function mergeAttachments(
  current: readonly AgentLocalAttachment[],
  incoming: readonly AgentLocalAttachment[],
) {
  const paths = new Set(current.map((attachment) => attachment.path));
  return [
    ...current,
    ...incoming.filter((attachment) => {
      if (paths.has(attachment.path)) return false;
      paths.add(attachment.path);
      return true;
    }),
  ].slice(0, AGENT_LOCAL_ATTACHMENT_LIMIT);
}

export function removeLastAttachment(
  attachments: readonly AgentLocalAttachment[],
) {
  return attachments.slice(0, -1);
}

export function formatAttachmentStrip(
  attachments: readonly AgentLocalAttachment[],
) {
  if (!attachments.length) return '';
  const chips = attachments
    .slice(0, 2)
    .map((attachment) => (
      `[${attachment.kind === 'directory' ? 'dir' : 'file'}:${compactName(attachment.name)}]`
    ));
  const remaining = attachments.length - chips.length;
  return [
    '📎',
    ...chips,
    ...(remaining > 0 ? [`+${remaining}`] : []),
    '· ⌫ remove last',
  ].join(' ');
}

export const formatAttachmentDisplayText = formatChatRequestDisplayText;

function compactName(name: string) {
  const characters = [...name];
  if (characters.length <= 18) return name;
  return `${characters.slice(0, 10).join('')}…${characters.slice(-7).join('')}`;
}
