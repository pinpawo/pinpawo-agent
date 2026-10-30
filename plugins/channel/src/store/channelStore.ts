export type ChannelMemberKind = 'human' | 'pet';
export type MemberRef = { kind: ChannelMemberKind; id: string };

export type ArtifactReference = { uri: string; label?: string; version?: string };
export type ChannelMention = { participantId: string; label?: string };

export type ChannelRow = {
  channelId: string;
  title: string;
  description?: string;
  /** Channel-authored collaboration instructions, separate from its public description. */
  prompt?: string;
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
/** Forward from `after`, or back from `before` (absent: from the newest message). */
export type MessageRange = { after: number; limit: number } | { before?: number; limit: number };
/**
 * Messages in sequence order, whichever way they were read. `nextAfter` reads
 * on toward newer messages while `hasMore`; `nextBefore` reads back toward
 * older ones while `hasEarlier`.
 */
export type MessagePage = {
  items: ChannelMessageRow[];
  nextAfter: number;
  hasMore: boolean;
  nextBefore: number;
  hasEarlier: boolean;
};

/**
 * Channel persistence. Data operations only: no permission checks, no writes
 * while reading, no configuration. Membership and every other rule belong to
 * ChannelService above it. Every operation is async so the store can sit on
 * any database; the store does not own the connection's lifecycle.
 */
export interface ChannelStore {
  /** Runs `work` atomically against the store it is given; nested calls join the outer transaction. */
  transaction<T>(work: (store: ChannelStore) => Promise<T>): Promise<T>;
  createChannel(row: ChannelRow): Promise<void>;
  updateChannel(channelId: string, patch: { title?: string; description?: string | null; prompt?: string | null; updatedAt: string }): Promise<void>;
  getChannel(channelId: string): Promise<ChannelRow | undefined>;
  /**
   * Inside a transaction, holds the Channel's row lock until it ends, so
   * membership changes to one Channel run one at a time. False when the
   * Channel does not exist.
   */
  lockChannel(channelId: string): Promise<boolean>;
  /** Pages in creation order. With `member`, only Channels where it is current. */
  listChannels(filter: { member?: MemberRef }, page: Page): Promise<PageOf<ChannelRow>>;
  /** Current and former members. */
  listMembers(channelId: string): Promise<ChannelMemberRow[]>;
  upsertMember(row: ChannelMemberRow): Promise<void>;
  /** With an externalRef the author already recorded, returns that earlier row unchanged. */
  appendMessage(row: Omit<ChannelMessageRow, 'sequence'>): Promise<ChannelMessageRow>;
  getMessage(channelId: string, messageId: string): Promise<ChannelMessageRow | undefined>;
  readMessages(channelId: string, range: MessageRange): Promise<MessagePage>;
  getSession(channelId: string, petId: string): Promise<ChannelSessionRow | undefined>;
  /** Returns the existing reservation for (channel, pet) if there is one. */
  reserveSession(row: ChannelSessionRow): Promise<ChannelSessionRow>;
  /** Marks the reserved session registered; throws when the reservation changed. */
  confirmSession(row: ChannelSessionRow): Promise<void>;
  listSessions(channelId: string): Promise<ChannelSessionRow[]>;
}
