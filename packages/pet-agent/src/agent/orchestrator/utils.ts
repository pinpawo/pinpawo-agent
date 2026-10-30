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
        // Provider and legacy checkpoint reasoning blocks can carry `text`;
        // never promote private reasoning to user-visible reply text.
        if ('type' in part && (part.type === 'reasoning' || part.type === 'thinking'
          || part.type === 'redacted_thinking' || part.type === 'reasoning_content' || part.type === 'analysis')) return '';
        return part.text;
      }
      return '';
    })
    .join('\n');
}

export function readMessageText(message: { content?: unknown }): string {
  return (readContentText(message.content) ?? '').trim();
}
