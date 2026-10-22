export type ChannelMemberKind = 'human' | 'pet';
export type ChannelAuthor = { kind: string; id: string };
export type ChannelRow = {
  channelId: string; title: string; description?: string;
  createdBy: ChannelAuthor; createdAt: string; updatedAt: string;
};
type ArtifactReference = { uri: string; label?: string; version?: string };
export type ChannelMessage = {
  sequence: number; messageId: string; channelId: string; author: ChannelAuthor; occurredAt: string;
  externalRef?: string; body: string; replyTo?: string;
  mentions: { participantId: string; label?: string }[]; artifacts: ArtifactReference[];
};
/** A current member, as messages address it. */
export type ChannelMember = { participantId: string; kind: ChannelMemberKind | string; id: string; label: string; joinedAt?: string };
export type ChannelContext = {
  channel: ChannelRow; members: ChannelMember[]; messages: ChannelMessage[];
  nextAfter: number; hasMore: boolean; nextBefore: number; hasEarlier: boolean; viewerParticipantId?: string;
};
/** Messages a Channel view reads at a time. */
export const CHANNEL_PAGE_LIMIT = 100;
/** The session a Pet uses in this Channel. */
export type ChannelSession = { channelId: string; petId: string; sessionId: string; registered: boolean };
/** What happened to one addressed member, from a send response or a `channel.delivery` event. Not stored by the Host. */
export type ChannelDelivery = {
  channelId: string; messageId?: string; participantId?: string;
  state: 'delivered' | 'accepted' | 'failed'; invocationId?: string; sessionId?: string; error?: string;
  /** Set when Channel routing, not a mention, chose the recipient. */
  via?: 'routing'; confidence?: number; reason?: string;
};
/** Channel routing looked at an unaddressed message and chose nobody. */
export type ChannelRoutingSkip = {
  channelId: string; messageId: string; reason: 'none' | 'low_confidence' | 'invalid' | 'error'; confidence?: number; detail?: string;
};
export type DispatchQueueEntry = { dispatchId: string; enqueuedAt: string; sessionId?: string; scope?: { namespace: string; id: string } };
export type DispatchQueue = {
  petId: string; state: 'open' | 'busy' | 'waiting' | 'blocked'; activeOperation: 'conversation' | 'dispatch' | null;
  queuedConversations: number; queuedDispatches: number; entries?: DispatchQueueEntry[]; activeDispatch?: DispatchQueueEntry;
};
export type ChannelPet = { petId: string; name: string };

/** Same encoding as the Channel Plugin, so every identity is safe in a direct Markdown link. */
export function channelParticipantId(author: ChannelAuthor): string {
  const encoded = encodeURIComponent(author.id).replace(/[!'()*]/g, char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
  return `${author.kind}:${encoded}`;
}

/** Reply preselects the author while it is a current member; former members never route. */
export function channelReplyRecipientId(author: ChannelAuthor | undefined, members: ChannelMember[] = []): string {
  return members.find(item => item.kind === author?.kind && item.id === author?.id)?.participantId ?? '';
}

export function channelMentionLabel(mention: ChannelMessage['mentions'][number], members: ChannelMember[], viewerParticipantId?: string): string {
  if (mention.participantId === viewerParticipantId) return 'Me';
  return members.find(item => item.participantId === mention.participantId)?.label ?? mention.label ?? mention.participantId;
}

/** A member as the composer's @ list offers it. */
export type ChannelMentionCandidate = { participantId: string; kind: string; label: string };

/** The Markdown link Channel reads as an @ of one participant. */
export function channelMentionMarkdown(mention: { participantId: string; label?: string | null }): string {
  const label = (mention.label || mention.participantId).replace(/[[\]\\]/g, '');
  return `[@${label}](participant:${mention.participantId})`;
}

/** Members whose name or id contains the typed text, names that start with it first. */
export function channelMentionMatches(members: ChannelMentionCandidate[], query: string): ChannelMentionCandidate[] {
  const text = query.trim().toLowerCase();
  const matches = members.filter(item => item.label.toLowerCase().includes(text) || item.participantId.toLowerCase().includes(text));
  return text ? [...matches].sort((a, b) => Number(!a.label.toLowerCase().startsWith(text)) - Number(!b.label.toLowerCase().startsWith(text))) : matches;
}

/** Participants a message body already shows as inline @ links. */
export function channelInlineMentionIds(body: string): Set<string> {
  return new Set([...body.matchAll(/\]\(participant:([^)\s]+)\)/g)].map(match => match[1]));
}

/** Composer serializes an explicit identity. Channel owns parsing and validation. */
export function channelMessageInput(channelId: string, participantId: string, body: string, reply?: ChannelMessage) {
  if (!body.trim()) throw new Error('Enter a message.');
  if (reply && reply.channelId !== channelId) throw new Error('Reply target is outside this Channel.');
  return { channelId, body: body.trim(), ...(participantId ? { mentions: [{ participantId }] } : {}),
    ...(reply ? { replyTo: reply.messageId } : {}) };
}

/** Names are presentation only; stable Pet IDs remain the routing identity. */
export function channelPetIdentity(petId: string, pets: ChannelPet[], registryKnown = true) {
  const pet = pets.find(item => item.petId === petId);
  const name = pet?.name.trim() || petId;
  const duplicate = pets.filter(item => (item.name.trim() || item.petId) === name).length > 1;
  return { name, removed: registryKnown && !pet, optionLabel: duplicate ? `${name} (${petId})` : name };
}

/** Authors are stored as written; a former member keeps its id and is named from the registry when possible. */
export function channelMessageIdentity(message: Pick<ChannelMessage, 'author'>, pets: ChannelPet[], registryKnown = true,
  members: ChannelMember[] = [], viewerParticipantId?: string) {
  const participantId = channelParticipantId(message.author);
  if (participantId === viewerParticipantId) return { name: 'Me', removed: false };
  const member = members.find(item => item.participantId === participantId);
  if (member) return { name: member.label, removed: false };
  return message.author.kind === 'pet'
    ? channelPetIdentity(message.author.id, pets, registryKnown)
    : { name: message.author.id, removed: false };
}

/** The registered session to read a Pet's work in this Channel, if it has one. */
export function channelPetSession(petId: string, sessions: ChannelSession[]): ChannelSession | undefined {
  return sessions.find(item => item.petId === petId && item.registered);
}

/** Pets that can still join: registered with Studio and not current members. */
export function channelJoinablePets(pets: ChannelPet[], members: ChannelMember[]): ChannelPet[] {
  return pets.filter(pet => !members.some(member => member.kind === 'pet' && member.id === pet.petId));
}

export function channelMessageSummary(message: Pick<ChannelMessage, 'body'>): string {
  return channelQuote(message.body);
}

export function channelDateKey(occurredAt: string): string {
  const date = new Date(occurredAt);
  return Number.isFinite(date.getTime()) ? `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}` : occurredAt;
}

/** Nearby messages from one author group; replies and day boundaries keep their own header. */
export function channelMessagesGroup(previous: ChannelMessage | undefined, current: ChannelMessage): boolean {
  if (!previous || previous.replyTo || current.replyTo) return false;
  const gap = Date.parse(current.occurredAt) - Date.parse(previous.occurredAt);
  return previous.channelId === current.channelId && previous.author.kind === current.author.kind
    && previous.author.id === current.author.id && channelDateKey(previous.occurredAt) === channelDateKey(current.occurredAt)
    && gap >= 0 && gap < 5 * 60_000;
}

export function channelQuote(body: string): string {
  const text = body.replace(/\[@([^\]]*)\]\(participant:[^)\s]+\)/g, '@$1').replace(/\s+/g, ' ').trim();
  return text.length > 160 ? `${text.slice(0, 157)}…` : text;
}

/** The outcome of one delivery, as shown next to its message. */
export function channelDeliveryLabel(delivery: ChannelDelivery): string {
  if (delivery.via === 'routing') {
    const score = delivery.confidence === undefined ? '' : ` ${Math.round(delivery.confidence * 100)}%`;
    return delivery.state === 'accepted' ? `routed${score}` : `routing ${delivery.state}`;
  }
  if (delivery.state === 'accepted') return 'dispatch accepted';
  return delivery.state;
}

export function channelRoutingSkipLabel(skip: ChannelRoutingSkip): string {
  if (skip.reason === 'none') return 'Not routed: no Pet needed';
  if (skip.reason === 'low_confidence') return 'Not routed: unsure who should answer';
  return 'Not routed: routing failed';
}

/** Later observations of the same (message, recipient) replace earlier ones. */
export function appendChannelDeliveries(current: ChannelDelivery[], next: ChannelDelivery[]): ChannelDelivery[] {
  const key = (item: ChannelDelivery) => `${item.channelId}\n${item.messageId ?? ''}\n${item.participantId ?? ''}\n${item.participantId ? '' : item.error ?? ''}`;
  const keys = new Set(next.map(key));
  return [...current.filter(item => !keys.has(key(item))), ...next].slice(-200);
}

/** Load every ordered page after `from`; reject a broken cursor rather than hiding recent results. */
export async function readChannelPages<T>(read: (path: string) => Promise<unknown>, path: string, key: string,
  onPage?: (page: Record<string, unknown>) => void, from = 0): Promise<T[]> {
  const entries: T[] = [];
  let after = from;
  for (;;) {
    const page = await read(`${path}${path.includes('?') ? '&' : '?'}after=${after}&limit=200`) as Record<string, unknown>;
    const values = page[key];
    if (!Array.isArray(values) || typeof page.hasMore !== 'boolean' || typeof page.nextAfter !== 'number') {
      throw new Error('Invalid Channel history response.');
    }
    entries.push(...values as T[]);
    onPage?.(page);
    if (!page.hasMore) return entries;
    if (page.nextAfter <= after || !Number.isSafeInteger(page.nextAfter)) throw new Error('Channel history cursor did not advance.');
    after = page.nextAfter;
  }
}

function channelContextPage(value: unknown): ChannelContext {
  const page = value as ChannelContext | null;
  if (!page?.channel || !Array.isArray(page.members) || !Array.isArray(page.messages)
    || typeof page.hasEarlier !== 'boolean' || !Number.isSafeInteger(page.nextBefore)) {
    throw new Error('Invalid Channel context response.');
  }
  return page;
}

/** The Channel, its current members and its newest messages; `before` reads the page older than that message instead. */
export async function readChannelContext(read: (path: string) => Promise<unknown>, channelId: string, before?: number): Promise<ChannelContext> {
  return channelContextPage(await read(`/channels/context?channelId=${encodeURIComponent(channelId)}`
    + `${before === undefined ? '' : `&before=${before}`}&limit=${CHANNEL_PAGE_LIMIT}`));
}

/** Every message after `after`, with members from the last page read: what a view holding the Channel up to `after` lacks. */
export async function readChannelLater(read: (path: string) => Promise<unknown>, channelId: string, after: number): Promise<ChannelContext> {
  let latest: ChannelContext | undefined;
  const messages = await readChannelPages<ChannelMessage>(read, `/channels/context?channelId=${encodeURIComponent(channelId)}`, 'messages',
    page => { latest = channelContextPage(page); }, after);
  return { ...latest!, messages };
}

/**
 * How far the open Channel's messages reach. `window` is new each time the
 * newest page is read afresh; a read started for an earlier window is stale.
 */
export type ChannelWindow = { channelId: string; window: number; nextAfter: number; nextBefore: number; hasEarlier: boolean };

/** After reading newer messages: only the newer edge moves. Undefined when the read is stale and must be dropped. */
export function channelWindowAfterLater(current: ChannelWindow | null, readFor: ChannelWindow, nextAfter: number): ChannelWindow | undefined {
  if (!current || current.window !== readFor.window) return undefined;
  return { ...current, nextAfter: Math.max(current.nextAfter, nextAfter) };
}

/** After reading an older page: only the older edge moves. Undefined when the read is stale and must be dropped. */
export function channelWindowAfterEarlier(current: ChannelWindow | null, readFor: ChannelWindow,
  page: Pick<ChannelContext, 'nextBefore' | 'hasEarlier'>): ChannelWindow | undefined {
  if (!current || current.window !== readFor.window) return undefined;
  return { ...current, nextBefore: page.nextBefore, hasEarlier: page.hasEarlier };
}

/** One ordered timeline; a message read twice is kept once. */
export function mergeChannelMessages(current: ChannelMessage[], next: ChannelMessage[]): ChannelMessage[] {
  const bySequence = new Map([...current, ...next].map(message => [message.sequence, message]));
  return [...bySequence.values()].sort((a, b) => a.sequence - b.sequence);
}
