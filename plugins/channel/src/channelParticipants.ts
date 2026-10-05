import { fromMarkdown } from 'mdast-util-from-markdown';
import type { Nodes } from 'mdast';
import { z } from 'zod';

export type ChannelParticipant = {
  participantId: string; kind: 'human' | 'pet' | 'bot'; id: string; label: string;
};
export const channelMentionSchema = z.object({
  participantId: z.string().trim().min(1).max(1024).optional(),
  // Read old records and explicit callers without introducing another protocol.
  petId: z.string().trim().min(1).max(256).optional(),
  label: z.string().max(500).optional(),
}).strict().refine(value => Boolean(value.participantId) !== Boolean(value.petId), 'A mention needs one unique identity.');
export type ChannelMention = z.infer<typeof channelMentionSchema>;

export function channelParticipantId(kind: ChannelParticipant['kind'], id: string): string {
  // encodeURIComponent leaves Markdown delimiters such as parentheses intact.
  // Encode them too so every registered identity is safe in a direct link.
  const encoded = encodeURIComponent(id).replace(/[!'()*]/g, char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
  return `${kind}:${encoded}`;
}
export function channelMentionId(mention: ChannelMention): string {
  return mention.participantId ?? channelParticipantId('pet', mention.petId!);
}

/** Direct Markdown links carry identity; labels never select a destination.
 * Quotes and code are examples, not addressed requests. This same parser is
 * used for operator messages and Host-authenticated Pet replies.
 */
export function parseChannelMentions(body: string, explicit: ChannelMention[], participants: ChannelParticipant[]): ChannelMention[] {
  const candidates = explicit.map(channelMentionId);
  const quotes = [...body.matchAll(/"[^"\n]*"|“[^”]*”|‘(?:[^’]|(?<=[\p{L}\p{N}])’(?=[\p{L}\p{N}]))*’|(?<![\p{L}\p{N}])'(?:[^'\n]|(?<=[\p{L}\p{N}])'(?=[\p{L}\p{N}]))*'(?![\p{L}\p{N}])/gu)]
    .map(match => [match.index, match.index + match[0].length] as const);
  function visit(node: Nodes): void {
    if (['blockquote', 'code', 'inlineCode', 'html'].includes(node.type)) return;
    if (node.type === 'link' && node.url.startsWith('participant:')) {
      const offset = node.position?.start.offset;
      if (offset !== undefined && quotes.some(([start, end]) => offset > start && offset < end)) return;
      const label = node.children.map(child => child.type === 'text' ? child.value : '').join('');
      if (label.startsWith('@')) candidates.push(node.url.slice('participant:'.length));
    }
    if ('children' in node) for (const child of node.children) visit(child);
  }
  visit(fromMarkdown(body));
  const registry = new Map(participants.map(participant => [participant.participantId, participant]));
  return [...new Set(candidates)].map(participantId => {
    const participant = registry.get(participantId);
    if (!participant) throw new Error(`Unknown Channel participant "${participantId}".`);
    return { participantId, label: participant.label };
  });
}
