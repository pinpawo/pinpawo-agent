import { randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';

const identifier = z.string().trim().min(1).max(256);
export const channelAuthorSchema = z.object({
  kind: z.enum(['human', 'bot', 'pet']),
  id: identifier,
}).strict();
export const artifactReferenceSchema = z.object({
  uri: z.string().trim().min(1).max(4096),
  label: z.string().max(500).optional(),
  version: z.string().min(1).max(500).optional(),
}).strict();
export const channelGoalSchema = z.object({
  title: z.string().trim().min(1).max(160),
  goal: z.string().trim().min(1).max(50_000),
  scope: z.string().trim().min(1).max(50_000),
  references: z.array(artifactReferenceSchema).max(100).default([]),
}).strict();
export const channelRevisionSchema = channelGoalSchema.extend({
  expectedRevision: z.number().int().positive().safe(),
  reason: z.string().trim().min(1).max(10_000),
  sourceMessageId: identifier.optional(),
}).strict();
export const channelMessageSchema = z.object({
  body: z.string().trim().min(1).max(100_000),
  replyTo: identifier.optional(),
  mentions: z.array(z.object({ petId: identifier }).strict()).max(100).default([]),
  artifacts: z.array(artifactReferenceSchema).max(100).default([]),
}).strict();
export const channelPageSchema = z.object({
  after: z.number().int().nonnegative().safe().default(0),
  limit: z.number().int().min(1).max(200).default(50),
}).strict();
export type ChannelAuthor = z.infer<typeof channelAuthorSchema>;
export type ChannelRevision = z.infer<typeof channelGoalSchema> & {
  kind: 'revision'; channelId: string; sequence: number; author: ChannelAuthor;
  occurredAt: string; reason: string; sourceMessageId?: string;
};
export type ChannelMessage = z.infer<typeof channelMessageSchema> & {
  kind: 'message'; channelId: string; sequence: number; messageId: string;
  author: ChannelAuthor; occurredAt: string; revision: number;
};
export type ChannelEntry = ChannelRevision | ChannelMessage;
export type ChannelPage = { entries: ChannelEntry[]; nextAfter: number; hasMore: boolean };

/** One append-only journal is the source of truth, including goal revisions.
 * Notifications are best effort after commit, not a durable delivery guarantee.
 */
export class ChannelService {
  private db: DatabaseSync | undefined;
  private readonly listeners = new Set<(entry: ChannelEntry) => void>();

  constructor(private readonly databasePath: string = ':memory:') {}

  init(): void {
    if (this.db) return;
    if (this.databasePath !== ':memory:') mkdirSync(path.dirname(this.databasePath), { recursive: true });
    const db = new DatabaseSync(this.databasePath);
    try {
      if (this.databasePath !== ':memory:') chmodSync(this.databasePath, 0o600);
      db.exec('PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL;');
      const version = (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
      if (version !== 0 && version !== 1) throw new Error(`Unsupported Channel schema version ${version}.`);
      db.exec(`
        CREATE TABLE IF NOT EXISTS channel_entries (
          sequence INTEGER PRIMARY KEY AUTOINCREMENT,
          channel_id TEXT NOT NULL,
          kind TEXT NOT NULL CHECK(kind IN ('revision', 'message')),
          message_id TEXT UNIQUE,
          data TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS channel_history ON channel_entries(channel_id, sequence);
        CREATE INDEX IF NOT EXISTS channel_revisions ON channel_entries(channel_id, kind, sequence);
        PRAGMA user_version=1;
      `);
      this.db = db;
    } catch (error) { db.close(); throw error; }
  }

  close(): void { this.db?.close(); this.db = undefined; }
  private database(): DatabaseSync {
    if (!this.db) throw new Error('Channel service is not started.');
    return this.db;
  }
  private decode(row: unknown): ChannelEntry | null {
    if (!row) return null;
    const value = row as { sequence: number; data: string };
    return { ...JSON.parse(value.data), sequence: value.sequence } as ChannelEntry;
  }
  private transaction<T>(run: () => T, readOnly = false): T {
    const db = this.database();
    db.exec(readOnly ? 'BEGIN' : 'BEGIN IMMEDIATE');
    try { const result = run(); db.exec('COMMIT'); return result; }
    catch (error) { db.exec('ROLLBACK'); throw error; }
  }
  private append(entry: Omit<ChannelRevision, 'sequence'> | Omit<ChannelMessage, 'sequence'>): ChannelEntry {
    const result = this.database().prepare(
      'INSERT INTO channel_entries(channel_id, kind, message_id, data) VALUES (?, ?, ?, ?)',
    ).run(entry.channelId, entry.kind, entry.kind === 'message' ? entry.messageId : null, JSON.stringify(entry));
    return { ...entry, sequence: Number(result.lastInsertRowid) } as ChannelEntry;
  }
  private publish<T extends ChannelEntry>(entry: T): T {
    for (const listener of this.listeners) {
      try { listener(structuredClone(entry)); }
      catch (error) { console.error('[channel] committed entry notification failed:', error); }
    }
    return entry;
  }
  subscribe(listener: (entry: ChannelEntry) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }
  getChannel(channelId: string): ChannelRevision {
    const id = identifier.parse(channelId);
    const entry = this.decode(this.database().prepare(
      "SELECT sequence, data FROM channel_entries WHERE channel_id=? AND kind='revision' ORDER BY sequence DESC LIMIT 1",
    ).get(id));
    if (!entry) throw new Error(`Unknown Channel "${id}".`);
    return entry as ChannelRevision;
  }
  listChannels(page: unknown = {}): { channels: ChannelRevision[]; nextAfter: number; hasMore: boolean } {
    const { after, limit } = channelPageSchema.parse(page);
    // Page by immutable creation sequence; revisions cannot move a Channel across pages.
    const rows = this.database().prepare(`SELECT MIN(sequence) AS created, channel_id FROM channel_entries
      WHERE kind='revision' GROUP BY channel_id HAVING MIN(sequence)>? ORDER BY created LIMIT ?`).all(after, limit + 1) as { created: number; channel_id: string }[];
    const selected = rows.slice(0, limit);
    return { channels: selected.map((row) => this.getChannel(row.channel_id)), nextAfter: selected.at(-1)?.created ?? after, hasMore: rows.length > limit };
  }
  createChannel(input: unknown, author: ChannelAuthor): ChannelRevision {
    const goal = channelGoalSchema.parse(input);
    const trustedAuthor = channelAuthorSchema.parse(author);
    const entry = this.transaction(() => this.append({
      ...goal, kind: 'revision', channelId: randomUUID(), author: trustedAuthor,
      occurredAt: new Date().toISOString(), reason: 'created',
    })) as ChannelRevision;
    return this.publish(entry);
  }
  reviseChannel(channelId: string, input: unknown, author: ChannelAuthor): ChannelRevision {
    const { expectedRevision, reason, sourceMessageId, ...goal } = channelRevisionSchema.parse(input);
    const trustedAuthor = channelAuthorSchema.parse(author);
    const entry = this.transaction(() => {
      const current = this.getChannel(channelId);
      if (current.sequence !== expectedRevision) throw new Error('Channel revision conflict; read current context before revising.');
      if (sourceMessageId) this.getMessage(current.channelId, sourceMessageId);
      return this.append({ ...goal, kind: 'revision', channelId: current.channelId, author: trustedAuthor,
        occurredAt: new Date().toISOString(), reason, ...(sourceMessageId ? { sourceMessageId } : {}),
      });
    }) as ChannelRevision;
    return this.publish(entry);
  }
  getMessage(channelId: string, messageId: string): ChannelMessage {
    const entry = this.decode(this.database().prepare(
      "SELECT sequence, data FROM channel_entries WHERE channel_id=? AND message_id=? AND kind='message'",
    ).get(identifier.parse(channelId), identifier.parse(messageId)));
    if (!entry) throw new Error('Message reference does not exist in this Channel.');
    return entry as ChannelMessage;
  }
  sendMessage(channelId: string, input: unknown, author: ChannelAuthor): ChannelMessage {
    const message = channelMessageSchema.parse(input);
    const trustedAuthor = channelAuthorSchema.parse(author);
    const seen = new Set<string>();
    if (message.mentions.some(({ petId }) => seen.has(petId) || !seen.add(petId))) throw new Error('Duplicate mention.');
    const entry = this.transaction(() => {
      const channel = this.getChannel(channelId);
      if (message.replyTo) this.getMessage(channel.channelId, message.replyTo);
      return this.append({ ...message, kind: 'message', channelId: channel.channelId,
        messageId: randomUUID(), revision: channel.sequence, author: trustedAuthor, occurredAt: new Date().toISOString(),
      });
    }) as ChannelMessage;
    return this.publish(entry);
  }
  readHistory(channelId: string, page: unknown = {}): ChannelPage {
    const { after, limit } = channelPageSchema.parse(page);
    const channel = this.getChannel(channelId);
    const rows = this.database().prepare(
      'SELECT sequence, data FROM channel_entries WHERE channel_id=? AND sequence>? ORDER BY sequence LIMIT ?',
    ).all(channel.channelId, after, limit + 1);
    const entries = rows.slice(0, limit).map((row) => this.decode(row)!);
    return { entries, nextAfter: entries.at(-1)?.sequence ?? after, hasMore: rows.length > limit };
  }
  readContext(channelId: string, page: unknown = {}) {
    return this.transaction(() => ({ channel: this.getChannel(channelId), history: this.readHistory(channelId, page) }), true);
  }
}
