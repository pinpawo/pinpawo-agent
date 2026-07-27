export const AGENT_LOCAL_ATTACHMENT_LIMIT = 20;

export type AgentLocalAttachment = {
  id: string;
  source: 'local-path';
  kind: 'file' | 'directory';
  path: string;
  name: string;
};

export function formatChatRequestDisplayText(
  message: string,
  attachments: readonly AgentLocalAttachment[],
) {
  if (!attachments.length) return message;
  const attachmentLines = attachments.map((attachment) => (
    `- ${attachment.kind === 'directory' ? 'directory' : 'file'}: ${attachment.name}`
  ));
  return [
    ...(message ? [message, ''] : []),
    'Attachments:',
    ...attachmentLines,
  ].join('\n');
}
