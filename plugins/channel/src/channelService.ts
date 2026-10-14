import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { channelMentionSchema, channelParticipantId, parseChannelMentions, type ChannelParticipant } from './channelParticipants';
import type {
  ChannelMemberRow, ChannelMention, ChannelMessageRow, ChannelRow, ChannelSessionRow, ChannelStore, MemberRef,
} from './channelStore';

const identifier = z.string().trim().min(1).max(256);
export const memberRefSchema = z.object({ kind: z.enum(['human', 'pet']), id: identifier }).strict();
export const artifactReferenceSchema = z.object({
  uri: z.string().trim().min(1).max(4096),
  label: z.string().max(500).optional(),
  version: z.string().min(1).max(500).optional(),
}).strict();
export const channelCreateSchema = z.object({
  title: z.string().trim().min(1).max(160),
  description: z.string().trim().max(50_000).optional(),
  /** The Pets that join with the creator. Required: no Pet joins implicitly. */
  pets: z.array(identifier).max(100),
}).strict();
export const channelUpdateSchema = z.object({
  title: z.string().trim().min(1).max(160).optional(),
  description: z.string().trim().max(50_000).nullable().optional(),
}).strict();
export const channelMessageSchema = z.object({
  body: z.string().trim().min(1).max(100_000),
  replyTo: identifier.optional(),
  mentions: z.array(channelMentionSchema).max(100).default([]),
  artifacts: z.array(artifactReferenceSchema).max(100).default([]),
}).strict();
export const channelPageSchema = z.object({
  after: z.number().int().nonnegative().safe().default(0),
  limit: z.number().int().min(1).max(200).default(50),
}).strict();

export type ChannelMessage = ChannelMessageRow;
export type ChannelSessionBinding = ChannelSessionRow;
export type ChannelMember = ChannelParticipant & { joinedAt: string };
export type ChannelEvent =
  | { type: 'channel.created'; payload: { channel: ChannelRow; members: ChannelMember[] } }
  | { type: 'channel.updated'; payload: { channel: ChannelRow } }
  | { type: 'channel.member.joined' | 'channel.member.left'; payload: { channelId: string; member: MemberRef; actor: MemberRef } }
  | { type: 'channel.message.created'; payload: ChannelMessage };

/** The actor is not a current member of an existing Channel. */
export class ChannelAccessError extends Error {}
export class ChannelNotFoundError extends Error {}

export type ChannelServiceOptions = {
  store: ChannelStore;
  /** The Studio's Pets; only these can join. */
  pets: () => Array<{ petId: string; name: string }>;
};

/**
 * Channel rules over a ChannelStore: membership decides who may read, speak,
 * be addressed and manage members. Who may call at all is Studio's decision.
 * Notifications are best effort after commit, not a durable delivery guarantee.
 */
export class ChannelService {
  readonly store: ChannelStore;
  private readonly pets: ChannelServiceOptions['pets'];
  private readonly listeners = new Set<(event: ChannelEvent) => void>();

  constructor(options: ChannelServiceOptions) {
    this.store = options.store;
    this.pets = options.pets;
  }

  subscribe(listener: (event: ChannelEvent) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }
  private publish(event: ChannelEvent): void {
    for (const listener of this.listeners) {
      try { listener(structuredClone(event)); }
      catch (error) { console.error('[channel] committed change notification failed:', error); }
    }
  }

  private requireChannel(channelId: string): ChannelRow {
    const id = identifier.parse(channelId);
    const channel = this.store.getChannel(id);
    if (!channel) throw new ChannelNotFoundError(`Unknown Channel "${id}".`);
    return channel;
  }
  /** The Channel, if `member` currently belongs to it. */
  requireMember(channelId: string, member: MemberRef): ChannelRow {
    const channel = this.requireChannel(channelId);
    const row = this.store.listMembers(channel.channelId).find(item => item.kind === member.kind && item.id === member.id);
    if (!row || row.leftAt) throw new ChannelAccessError(`${member.kind}:${member.id} is not a member of Channel "${channel.channelId}".`);
    return channel;
  }
  private requirePet(petId: string): void {
    if (!this.pets().some(pet => pet.petId === petId)) throw new Error(`Unknown Pet "${petId}".`);
  }
  private label(member: MemberRef): string {
    return member.kind === 'pet' ? this.pets().find(pet => pet.petId === member.id)?.name ?? member.id : member.id;
  }
  private memberView(row: ChannelMemberRow): ChannelMember {
    return { participantId: channelParticipantId(row.kind, row.id), kind: row.kind, id: row.id, label: this.label(row), joinedAt: row.joinedAt };
  }
  /** Current members, as messages address them. */
  members(channelId: string): ChannelMember[] {
    return this.store.listMembers(channelId).filter(row => !row.leftAt).map(row => this.memberView(row));
  }

  createChannel(actor: MemberRef, input: unknown): { channel: ChannelRow; members: ChannelMember[] } {
    const value = channelCreateSchema.parse(input);
    const creator = memberRefSchema.parse(actor);
    const pets = [...new Set(value.pets)];
    for (const petId of pets) this.requirePet(petId);
    const now = new Date().toISOString();
    const channel: ChannelRow = {
      channelId: randomUUID(), title: value.title, ...(value.description ? { description: value.description } : {}),
      createdBy: creator, createdAt: now, updatedAt: now,
    };
    this.store.transaction(() => {
      this.store.createChannel(channel);
      for (const member of [creator, ...pets.filter(id => creator.kind !== 'pet' || creator.id !== id).map(id => ({ kind: 'pet' as const, id }))]) {
        this.store.upsertMember({ channelId: channel.channelId, ...member, joinedAt: now });
      }
    });
    const result = { channel, members: this.members(channel.channelId) };
    this.publish({ type: 'channel.created', payload: result });
    return result;
  }

  updateChannel(actor: MemberRef, channelId: string, input: unknown): ChannelRow {
    const patch = channelUpdateSchema.parse(input);
    const channel = this.store.transaction(() => {
      const current = this.requireMember(channelId, actor);
      this.store.updateChannel(current.channelId, {
        ...(patch.title !== undefined ? { title: patch.title } : {}),
        ...(patch.description !== undefined ? { description: patch.description || null } : {}),
        updatedAt: new Date().toISOString(),
      });
      return this.store.getChannel(current.channelId)!;
    });
    this.publish({ type: 'channel.updated', payload: { channel } });
    return channel;
  }

  listChannels(actor: MemberRef, page: unknown = {}): { channels: ChannelRow[]; nextAfter: number; hasMore: boolean } {
    const { items, ...rest } = this.store.listChannels({ member: memberRefSchema.parse(actor) }, channelPageSchema.parse(page));
    return { channels: items, ...rest };
  }

  readContext(actor: MemberRef, channelId: string, page: unknown = {}) {
    const value = channelPageSchema.parse(page);
    const channel = this.requireMember(channelId, actor);
    const { items, ...rest } = this.store.readMessages(channel.channelId, value);
    return { channel, members: this.members(channel.channelId), messages: items, ...rest };
  }

  listMembers(actor: MemberRef, channelId: string): ChannelMember[] {
    return this.members(this.requireMember(channelId, actor).channelId);
  }

  addMember(actor: MemberRef, channelId: string, value: unknown): ChannelMember {
    const member = memberRefSchema.parse(value);
    if (member.kind === 'pet') this.requirePet(member.id);
    const row = this.store.transaction(() => {
      const channel = this.requireMember(channelId, actor);
      const existing = this.store.listMembers(channel.channelId).find(item => item.kind === member.kind && item.id === member.id);
      if (existing && !existing.leftAt) return { row: existing, joined: false };
      const row = { channelId: channel.channelId, ...member, joinedAt: new Date().toISOString() };
      this.store.upsertMember(row);
      return { row, joined: true };
    });
    if (row.joined) this.publish({ type: 'channel.member.joined', payload: { channelId: row.row.channelId, member, actor } });
    return this.memberView(row.row);
  }

  removeMember(actor: MemberRef, channelId: string, value: unknown): void {
    const member = memberRefSchema.parse(value);
    const left = this.store.transaction(() => {
      const channel = this.requireMember(channelId, actor);
      const existing = this.store.listMembers(channel.channelId).find(item => item.kind === member.kind && item.id === member.id);
      if (!existing || existing.leftAt) return null;
      this.store.upsertMember({ ...existing, leftAt: new Date().toISOString() });
      return channel.channelId;
    });
    if (left) this.publish({ type: 'channel.member.left', payload: { channelId: left, member, actor } });
  }

  /**
   * Save one member's message. Mentions are resolved against current members.
   * A human's unknown mention rejects the message; a Pet's reply has no one to
   * reject it to, so it is kept without mentions and `mentionError` says why.
   * With an externalRef already saved for this author, the earlier message
   * is returned and `created` is false.
   */
  postMessage(author: MemberRef, channelId: string, input: unknown, options: { externalRef?: string } = {}): {
    message: ChannelMessage; created: boolean; mentionError?: string;
  } {
    const value = channelMessageSchema.parse(input);
    const trustedAuthor = memberRefSchema.parse(author);
    let mentionError: string | undefined;
    const result = this.store.transaction(() => {
      const channel = this.requireMember(channelId, trustedAuthor);
      if (value.replyTo && !this.store.getMessage(channel.channelId, value.replyTo)) {
        throw new Error('Message reference does not exist in this Channel.');
      }
      let mentions: ChannelMention[];
      try { mentions = parseChannelMentions(value.body, value.mentions, this.members(channel.channelId)); }
      catch (error) {
        if (trustedAuthor.kind !== 'pet') throw error;
        mentionError = error instanceof Error ? error.message : String(error);
        mentions = [];
      }
      const messageId = randomUUID();
      const message = this.store.appendMessage({
        messageId, channelId: channel.channelId, author: trustedAuthor, occurredAt: new Date().toISOString(),
        ...(options.externalRef ? { externalRef: options.externalRef } : {}),
        body: value.body, ...(value.replyTo ? { replyTo: value.replyTo } : {}), mentions, artifacts: value.artifacts,
      });
      return { message, created: message.messageId === messageId };
    });
    if (result.created) this.publish({ type: 'channel.message.created', payload: result.message });
    return { ...result, ...(result.created && mentionError ? { mentionError } : {}) };
  }

  getMessage(channelId: string, messageId: string): ChannelMessage | undefined {
    return this.store.getMessage(channelId, messageId);
  }

  /** The (Channel, Pet) session, reserved on first use. */
  reserveSession(channelId: string, petId: string, allocate: () => string): ChannelSessionBinding {
    return this.store.transaction(() => {
      const channel = this.requireChannel(channelId);
      return this.store.getSession(channel.channelId, petId)
        ?? this.store.reserveSession({ channelId: channel.channelId, petId, sessionId: identifier.parse(allocate()), registered: false });
    });
  }
  confirmSession(binding: ChannelSessionBinding): ChannelSessionBinding {
    if (!binding.registered) this.store.confirmSession(binding);
    return { ...binding, registered: true };
  }
  getSession(channelId: string, petId: string): ChannelSessionBinding | undefined {
    return this.store.getSession(channelId, petId);
  }
  listSessions(actor: MemberRef, channelId: string): ChannelSessionBinding[] {
    return this.store.listSessions(this.requireMember(channelId, actor).channelId);
  }
}
