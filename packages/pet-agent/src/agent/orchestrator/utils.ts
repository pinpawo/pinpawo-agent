export function clipForPrompt(text: string, maxLength = 180): string {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, maxLength - 1)}…`;
}

/**
 * Flatten message `content` (a string or an array of content blocks) to text.
 * Blocks are joined with newlines; anything else yields null.
 */
export function readContentText(content: unknown): string | null {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return null;
  return content
    .map((part) => {
      if (typeof part === 'string') return part;
      if (part && typeof part === 'object' && 'text' in part && typeof part.text === 'string') {
        return part.text;
      }
      return '';
    })
    .join('\n');
}

export function readMessageText(message: { content?: unknown }): string {
  return (readContentText(message.content) ?? '').trim();
}
