import type { Deliverable } from '@pinpawo/agent-contracts';
import { channelParticipantId } from './channelParticipants';
import type { ChannelMessageRow, ChannelConsumptionRow } from './store/channelStore';

/** Who started a Pet's spontaneous run in a Channel. */
export type ChannelRunOrigin = { kind: 'scheduler' | 'trigger'; id: string };

// Routing provenance only. Preparation instructions travel in invocation context.
const routingContextHint = {
  source: 'channel-routing',
  action: 'read-latest-channel',
} as const;

/** Explicit references from this message and its one addressed reply. */
export function channelDispatchAttachments(message: ChannelMessageRow, original?: ChannelMessageRow): Deliverable[] {
  const reply = original && message.replyTo === original.messageId && message.channelId === original.channelId
    ? original : undefined;
  const seen = new Set<string>();
  return [...(message.deliverables ?? []), ...(reply?.deliverables ?? [])]
    .filter(({ uri }) => {
      if (seen.has(uri)) return false;
      seen.add(uri);
      return true;
    })
    .map(reference => ({ ...reference }));
}

function fenced(input: Record<string, unknown>): string {
  const text = JSON.stringify(input, null, 2);
  // A copied envelope is quoted data, not another active handoff. Body content
  // cannot close the fence or replace the server-assigned top-level fields.
  let length = 3;
  for (const match of text.matchAll(/`+/g)) length = Math.max(length, match[0].length + 1);
  const fence = '`'.repeat(length);
  return `${fence}json\n${text}\n${fence}`;
}

/**
 * Built only from stored messages whose authors were assigned by Channel / Host.
 * The participantId is the author's identity; the label, when the author is
 * still a member, is only how to call them.
 */
export function channelDispatchInput(
  message: ChannelMessageRow,
  original?: ChannelMessageRow,
  labelOf: (participantId: string) => string | undefined = () => undefined,
  /** `routing`: nobody addressed this message; Channel routing chose this Pet. */
  addressedBy?: 'routing',
  /** Model-generated attention suggestion, separate from the fixed reading instruction. */
  focus?: string,
): string {
  const author = (entry: ChannelMessageRow) => {
    const participantId = channelParticipantId(entry.author.kind, entry.author.id);
    const label = labelOf(participantId);
    return { participantId, kind: entry.author.kind, ...(label === undefined ? {} : { label }) };
  };
  return fenced({
    type: 'channel_message', version: 1,
    channelId: message.channelId, messageId: message.messageId,
    author: author(message), body: message.body,
    ...(message.deliverables !== undefined ? { deliverables: message.deliverables } : {}),
    ...(original ? { replyTo: { messageId: original.messageId, author: author(original), body: original.body,
      ...(original.deliverables !== undefined ? { deliverables: original.deliverables } : {}),
    } } : {}),
    ...(addressedBy ? { addressedBy, contextHint: { ...routingContextHint, ...(focus?.trim() ? { focus: focus.trim() } : {}) } } : {}),
  });
}

/** A scheduled or triggered instruction for a Pet in its Channel. It has no author and is not a Channel message. */
export function channelTaskInput(channelId: string, origin: ChannelRunOrigin, body: string): string {
  return fenced({ type: 'channel_task', version: 1, channelId, origin: { kind: origin.kind, id: origin.id }, body });
}

/** Full stored messages for one Head-selected Pet; model suggestions never replace their authors. */
export function channelBatchInput(options: {
  progress: ChannelConsumptionRow;
  throughSequence: number;
  messages: readonly ChannelMessageRow[];
  originals: ReadonlyMap<string, ChannelMessageRow>;
  labelOf: (participantId: string) => string | undefined;
  headReply?: ChannelMessageRow;
  focus?: string;
}): string {
  const view = (row: ChannelMessageRow, includeReply = true): Record<string, unknown> => {
    const participantId = channelParticipantId(row.author.kind, row.author.id);
    const label = options.labelOf(participantId);
    const original = row.replyTo ? options.originals.get(row.replyTo) : undefined;
    return {
      sequence: row.sequence, messageId: row.messageId,
      author: { participantId, kind: row.author.kind, ...(label ? { label } : {}) },
      body: row.body, mentions: row.mentions,
      ...(row.source ? { source: row.source } : {}),
      ...(row.addressingError ? { addressingError: row.addressingError } : {}),
      ...(row.deliverables !== undefined ? { deliverables: row.deliverables } : {}),
      ...(includeReply && original ? { replyTo: view(original, false) } : {}),
    };
  };
  return fenced({
    type: 'channel_batch', version: 1, channelId: options.progress.channelId,
    petParticipantId: channelParticipantId('pet', options.progress.petId),
    membershipId: options.progress.membershipId,
    range: { after: options.progress.afterSequence, through: options.throughSequence },
    messages: options.messages.map(row => view(row)),
    ...(options.headReply ? { headReply: view(options.headReply) } : {}),
    contextHint: { source: 'channel-head', action: 'read-latest-channel', ...(options.focus ? { focus: options.focus } : {}) },
  });
}

/** Read only the complete Channel-owned outer envelope, never copied body text. */
export function readChannelBatchContext(channelId: string, request?: string): { membershipId: string; petParticipantId: string; focus?: string } | undefined {
  const match = request && /^(`{3,})json\n([\s\S]*)\n\1$/.exec(request);
  if (!match) return undefined;
  let value: unknown;
  try { value = JSON.parse(match[2]!); } catch { return undefined; }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const input = value as Record<string, unknown>;
  const hint = input.contextHint as Record<string, unknown> | undefined;
  if (input.type !== 'channel_batch' || input.version !== 1 || input.channelId !== channelId
    || typeof input.membershipId !== 'string' || !input.membershipId || typeof input.petParticipantId !== 'string'
    || !hint || hint.source !== 'channel-head' || hint.action !== 'read-latest-channel') return undefined;
  const focus = typeof hint.focus === 'string' && hint.focus.trim().length <= 500 ? hint.focus.trim() : '';
  return { membershipId: input.membershipId, petParticipantId: input.petParticipantId, ...(focus ? { focus } : {}) };
}
