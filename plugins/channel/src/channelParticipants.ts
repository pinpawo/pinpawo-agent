import { fromMarkdown } from 'mdast-util-from-markdown';
import type { Nodes } from 'mdast';
import { z } from 'zod';
import type { ChannelMemberKind, ChannelMention } from './store/channelStore';

/** A current Channel member as messages address it. */
export type ChannelParticipant = {
  participantId: string; kind: ChannelMemberKind; id: string; label: string;
};
export const channelMentionSchema = z.object({
  participantId: z.string().trim().min(1).max(1024),
  label: z.string().max(500).optional(),
}).strict();

export function channelParticipantId(kind: ChannelMemberKind, id: string): string {
  // encodeURIComponent leaves Markdown delimiters such as parentheses intact.
  // Encode them too so every registered identity is safe in a direct link.
  const encoded = encodeURIComponent(id).replace(/[!'()*]/g, char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
  return `${kind}:${encoded}`;
}

/** Direct Markdown links carry identity; labels never select a destination.
 * Quotes and code are examples, not addressed requests. Every member's
 * message, a human's or a Pet's, is parsed the same way against the
 * Channel's current members.
 */
export function parseChannelMentions(body: string, explicit: ChannelMention[], participants: ChannelParticipant[]): ChannelMention[] {
  const candidates = explicit.map(mention => mention.participantId);
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
