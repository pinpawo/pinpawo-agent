import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { channelMentionSchema, channelParticipantId, parseChannelMentions, type ChannelParticipant } from './channelParticipants';
import type {
  ChannelMemberRow, ChannelMention, ChannelMessageRow, ChannelRow, ChannelSessionRow, ChannelStore, MemberRef,
} from './store/channelStore';

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
  /** A Studio client by id; only active clients can be added as human members. */
  humans: (clientId: string) => Promise<{ label: string; active: boolean } | undefined>;
};

/**
 * Channel rules over a ChannelStore: membership decides who may read, speak,
 * be addressed and manage members. Who may call at all is Studio's decision.
 * Notifications are best effort after commit, not a durable delivery guarantee.
 */
export class ChannelService {
  readonly store: ChannelStore;
  private readonly pets: ChannelServiceOptions['pets'];
  private readonly humans: ChannelServiceOptions['humans'];
  private readonly listeners = new Set<(event: ChannelEvent) => void>();

  constructor(options: ChannelServiceOptions) {
    this.store = options.store;
    this.pets = options.pets;
    this.humans = options.humans;
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

  private async requireChannel(store: ChannelStore, channelId: string): Promise<ChannelRow> {
    const id = identifier.parse(channelId);
    const channel = await store.getChannel(id);
    if (!channel) throw new ChannelNotFoundError(`Unknown Channel "${id}".`);
    return channel;
  }
  private async requireMemberIn(store: ChannelStore, channelId: string, member: MemberRef): Promise<ChannelRow> {
    const channel = await this.requireChannel(store, channelId);
    const row = (await store.listMembers(channel.channelId)).find(item => item.kind === member.kind && item.id === member.id);
    if (!row || row.leftAt) throw new ChannelAccessError(`${member.kind}:${member.id} is not a member of Channel "${channel.channelId}".`);
    return channel;
  }
  /** The Channel, if `member` currently belongs to it. */
  requireMember(channelId: string, member: MemberRef): Promise<ChannelRow> {
    return this.requireMemberIn(this.store, channelId, member);
  }
  private requirePet(petId: string): void {
    if (!this.pets().some(pet => pet.petId === petId)) throw new Error(`Unknown Pet "${petId}".`);
  }
  private async requireJoinable(member: MemberRef): Promise<void> {
    if (member.kind === 'pet') return this.requirePet(member.id);
    if (!(await this.humans(member.id))?.active) throw new Error(`Unknown Studio client "${member.id}".`);
  }
  /**
   * Labels of these humans, read when shown so a renamed client shows its
   * current name. Never call inside a store transaction: the client lookup
   * is another query, and on SQLite's single connection it would wait for
   * the transaction forever.
   */
  private async humanLabels(rows: MemberRef[]): Promise<Map<string, string>> {
    const ids = [...new Set(rows.filter(row => row.kind === 'human').map(row => row.id))];
    const labels = await Promise.all(ids.map(async id => [id, (await this.humans(id))?.label ?? id] as const));
    return new Map(labels);
  }
  private memberView(row: ChannelMemberRow, humans: Map<string, string>): ChannelMember {
    const label = row.kind === 'pet' ? this.pets().find(pet => pet.petId === row.id)?.name ?? row.id : humans.get(row.id) ?? row.id;
    return { participantId: channelParticipantId(row.kind, row.id), kind: row.kind, id: row.id, label, joinedAt: row.joinedAt };
  }
  /** Current members of a Channel, with human labels read before any transaction began. */
  private async membersIn(store: ChannelStore, channelId: string, humans: Map<string, string>): Promise<ChannelMember[]> {
    return (await store.listMembers(channelId)).filter(row => !row.leftAt).map(row => this.memberView(row, humans));
  }
  /** Current members, as messages address them. */
  async members(channelId: string): Promise<ChannelMember[]> {
    const rows = (await this.store.listMembers(channelId)).filter(row => !row.leftAt);
    const labels = await this.humanLabels(rows);
    return rows.map(row => this.memberView(row, labels));
  }

  async createChannel(actor: MemberRef, input: unknown): Promise<{ channel: ChannelRow; members: ChannelMember[] }> {
    const value = channelCreateSchema.parse(input);
    const creator = memberRefSchema.parse(actor);
    const pets = [...new Set(value.pets)];
    for (const petId of pets) this.requirePet(petId);
    const labels = await this.humanLabels([creator]);
    const now = new Date().toISOString();
    const channel: ChannelRow = {
      channelId: randomUUID(), title: value.title, ...(value.description ? { description: value.description } : {}),
      createdBy: creator, createdAt: now, updatedAt: now,
    };
    const result = await this.store.transaction(async (store) => {
      await store.createChannel(channel);
      for (const member of [creator, ...pets.filter(id => creator.kind !== 'pet' || creator.id !== id).map(id => ({ kind: 'pet' as const, id }))]) {
        await store.upsertMember({ channelId: channel.channelId, ...member, joinedAt: now });
      }
      return { channel, members: await this.membersIn(store, channel.channelId, labels) };
    });
    this.publish({ type: 'channel.created', payload: result });
    return result;
  }

  async updateChannel(actor: MemberRef, channelId: string, input: unknown): Promise<ChannelRow> {
    const patch = channelUpdateSchema.parse(input);
    const channel = await this.store.transaction(async (store) => {
      const current = await this.requireMemberIn(store, channelId, actor);
      await store.updateChannel(current.channelId, {
        ...(patch.title !== undefined ? { title: patch.title } : {}),
        ...(patch.description !== undefined ? { description: patch.description || null } : {}),
        updatedAt: new Date().toISOString(),
      });
      return (await store.getChannel(current.channelId))!;
    });
    this.publish({ type: 'channel.updated', payload: { channel } });
    return channel;
  }

  async listChannels(actor: MemberRef, page: unknown = {}): Promise<{ channels: ChannelRow[]; nextAfter: number; hasMore: boolean }> {
    const { items, ...rest } = await this.store.listChannels({ member: memberRefSchema.parse(actor) }, channelPageSchema.parse(page));
    return { channels: items, ...rest };
  }

  async readContext(actor: MemberRef, channelId: string, page: unknown = {}) {
    const value = channelPageSchema.parse(page);
    const channel = await this.requireMember(channelId, actor);
    const { items, ...rest } = await this.store.readMessages(channel.channelId, value);
    return { channel, members: await this.members(channel.channelId), messages: items, ...rest };
  }

  async listMembers(actor: MemberRef, channelId: string): Promise<ChannelMember[]> {
    return this.members((await this.requireMember(channelId, actor)).channelId);
  }

  async addMember(actor: MemberRef, channelId: string, value: unknown): Promise<ChannelMember> {
    const member = memberRefSchema.parse(value);
    await this.requireJoinable(member);
    const result = await this.store.transaction(async (store) => {
      const channel = await this.requireMemberIn(store, channelId, actor);
      const existing = (await store.listMembers(channel.channelId)).find(item => item.kind === member.kind && item.id === member.id);
      if (existing && !existing.leftAt) return { row: existing, joined: false };
      const row = { channelId: channel.channelId, ...member, joinedAt: new Date().toISOString() };
      await store.upsertMember(row);
      return { row, joined: true };
    });
    if (result.joined) this.publish({ type: 'channel.member.joined', payload: { channelId: result.row.channelId, member, actor } });
    return this.memberView(result.row, await this.humanLabels([result.row]));
  }

  async removeMember(actor: MemberRef, channelId: string, value: unknown): Promise<void> {
    const member = memberRefSchema.parse(value);
    const left = await this.store.transaction(async (store) => {
      const channel = await this.requireMemberIn(store, channelId, actor);
      const existing = (await store.listMembers(channel.channelId)).find(item => item.kind === member.kind && item.id === member.id);
      if (!existing || existing.leftAt) return null;
      await store.upsertMember({ ...existing, leftAt: new Date().toISOString() });
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
  async postMessage(author: MemberRef, channelId: string, input: unknown, options: { externalRef?: string } = {}): Promise<{
    message: ChannelMessage; created: boolean; mentionError?: string;
  }> {
    const value = channelMessageSchema.parse(input);
    const trustedAuthor = memberRefSchema.parse(author);
    // Mentions record labels; read them first (a member who joins meanwhile is labelled by id).
    const labels = await this.humanLabels(await this.store.listMembers(identifier.parse(channelId)));
    let mentionError: string | undefined;
    const result = await this.store.transaction(async (store) => {
      const channel = await this.requireMemberIn(store, channelId, trustedAuthor);
      if (value.replyTo && !(await store.getMessage(channel.channelId, value.replyTo))) {
        throw new Error('Message reference does not exist in this Channel.');
      }
      let mentions: ChannelMention[];
      try { mentions = parseChannelMentions(value.body, value.mentions, await this.membersIn(store, channel.channelId, labels)); }
      catch (error) {
        if (trustedAuthor.kind !== 'pet') throw error;
        mentionError = error instanceof Error ? error.message : String(error);
        mentions = [];
      }
      const messageId = randomUUID();
      const message = await store.appendMessage({
        messageId, channelId: channel.channelId, author: trustedAuthor, occurredAt: new Date().toISOString(),
        ...(options.externalRef ? { externalRef: options.externalRef } : {}),
        body: value.body, ...(value.replyTo ? { replyTo: value.replyTo } : {}), mentions, artifacts: value.artifacts,
      });
      return { message, created: message.messageId === messageId };
    });
    if (result.created) this.publish({ type: 'channel.message.created', payload: result.message });
    return { ...result, ...(result.created && mentionError ? { mentionError } : {}) };
  }

  getMessage(channelId: string, messageId: string): Promise<ChannelMessage | undefined> {
    return this.store.getMessage(channelId, messageId);
  }

  /** The (Channel, Pet) session, reserved on first use. */
  reserveSession(channelId: string, petId: string, allocate: () => string): Promise<ChannelSessionBinding> {
    return this.store.transaction(async (store) => {
      const channel = await this.requireChannel(store, channelId);
      return await store.getSession(channel.channelId, petId)
        ?? await store.reserveSession({ channelId: channel.channelId, petId, sessionId: identifier.parse(allocate()), registered: false });
    });
  }
  async confirmSession(binding: ChannelSessionBinding): Promise<ChannelSessionBinding> {
    if (!binding.registered) await this.store.confirmSession(binding);
    return { ...binding, registered: true };
  }
  getSession(channelId: string, petId: string): Promise<ChannelSessionBinding | undefined> {
    return this.store.getSession(channelId, petId);
  }
  async listSessions(actor: MemberRef, channelId: string): Promise<ChannelSessionBinding[]> {
    return this.store.listSessions((await this.requireMember(channelId, actor)).channelId);
  }
}
