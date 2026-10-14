export type ChannelMemberKind = 'human' | 'pet';
export type MemberRef = { kind: ChannelMemberKind; id: string };

export type ArtifactReference = { uri: string; label?: string; version?: string };
export type ChannelMention = { participantId: string; label?: string };

export type ChannelRow = {
  channelId: string;
  title: string;
  description?: string;
  createdBy: MemberRef;
  createdAt: string;
  updatedAt: string;
};

export type ChannelMemberRow = {
  channelId: string;
  kind: ChannelMemberKind;
  id: string;
  joinedAt: string;
  /** Absent while the member is current. */
  leftAt?: string;
};

export type ChannelMessageRow = {
  /** Assigned by the store on append; the page cursor. */
  sequence: number;
  messageId: string;
  channelId: string;
  author: MemberRef;
  occurredAt: string;
  /** The message's id in the system it came from (an Agent Session message id); unique per author. */
  externalRef?: string;
  body: string;
  replyTo?: string;
  mentions: ChannelMention[];
  artifacts: ArtifactReference[];
};

export type ChannelSessionRow = {
  channelId: string;
  petId: string;
  sessionId: string;
  /** Whether the Host has created the session; until then it is only reserved. */
  registered: boolean;
};

export type Page = { after: number; limit: number };
export type PageOf<T> = { items: T[]; nextAfter: number; hasMore: boolean };

/**
 * Channel persistence. Data operations only: no permission checks, no writes
 * while reading, no configuration. Membership and every other rule belong to
 * ChannelService above it.
 */
export interface ChannelStore {
  init(): void;
  close(): void;
  transaction<T>(run: () => T): T;
  createChannel(row: ChannelRow): void;
  updateChannel(channelId: string, patch: { title?: string; description?: string | null; updatedAt: string }): void;
  getChannel(channelId: string): ChannelRow | undefined;
  /** Pages in creation order. With `member`, only Channels where it is current. */
  listChannels(filter: { member?: MemberRef }, page: Page): PageOf<ChannelRow>;
  /** Current and former members. */
  listMembers(channelId: string): ChannelMemberRow[];
  upsertMember(row: ChannelMemberRow): void;
  /** With an externalRef the author already recorded, returns that earlier row unchanged. */
  appendMessage(row: Omit<ChannelMessageRow, 'sequence'>): ChannelMessageRow;
  getMessage(channelId: string, messageId: string): ChannelMessageRow | undefined;
  readMessages(channelId: string, page: Page): PageOf<ChannelMessageRow>;
  getSession(channelId: string, petId: string): ChannelSessionRow | undefined;
  /** Returns the existing reservation for (channel, pet) if there is one. */
  reserveSession(row: ChannelSessionRow): ChannelSessionRow;
  /** Marks the reserved session registered; throws when the reservation changed. */
  confirmSession(row: ChannelSessionRow): void;
  listSessions(channelId: string): ChannelSessionRow[];
}
