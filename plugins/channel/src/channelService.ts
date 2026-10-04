import { parsePendingInterruptProjection, type PendingInterruptProjection } from '@pinpawo/agent-session';
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
export type ChannelSessionBinding = { channelId: string; petId: string; sessionId: string; registered: boolean };
export type ChannelMessageSource = { petId: string; sessionId: string; invocationId: string };
export type ChannelMessage = z.infer<typeof channelMessageSchema> & {
  source?: ChannelMessageSource;
  kind: 'message'; channelId: string; sequence: number; messageId: string;
  author: ChannelAuthor; occurredAt: string; revision: number;
};
/** Historical observation only, never an authoritative approval state. */
export type ChannelInterruptNotification = {
  sequence: number; channelId: string; source: ChannelMessageSource;
  occurredAt: string; pendingInterrupt: PendingInterruptProjection;
};
export type ChannelEntry = ChannelRevision | ChannelMessage;
export type ChannelPage = { entries: ChannelEntry[]; nextAfter: number; hasMore: boolean };
export type ChannelExecutionState = 'admitting' | 'queued' | 'running' | 'waiting' | 'completed' | 'interrupted' | 'failed';
export type ChannelExecution = {
  executionId: string; channelId: string; petId: string; sessionId: string;
  messageId?: string; invocationId?: string; state: ChannelExecutionState;
  occurredAt: string; error?: string; deliveryError?: string; observerId: string;
};

/** One append-only journal is the source of truth, including goal revisions.
 * Notifications are best effort after commit, not a durable delivery guarantee.
 */
export class ChannelService {
  private db: DatabaseSync | undefined;
  private observerId = randomUUID();
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
      if (![0, 1, 2, 3, 4].includes(version)) throw new Error(`Unsupported Channel schema version ${version}.`);
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
        CREATE TABLE IF NOT EXISTS channel_sessions (
          channel_id TEXT NOT NULL, pet_id TEXT NOT NULL, session_id TEXT NOT NULL,
          registered INTEGER NOT NULL DEFAULT 0,
          PRIMARY KEY(channel_id, pet_id), UNIQUE(pet_id, session_id)
        );
        CREATE TABLE IF NOT EXISTS channel_outputs (
          pet_id TEXT NOT NULL, session_id TEXT NOT NULL, invocation_id TEXT NOT NULL,
          message_id TEXT NOT NULL,
          PRIMARY KEY(pet_id, session_id, invocation_id)
        );
        CREATE TABLE IF NOT EXISTS channel_interrupt_notifications (
          sequence INTEGER PRIMARY KEY AUTOINCREMENT, channel_id TEXT NOT NULL,
          pet_id TEXT NOT NULL, session_id TEXT NOT NULL, invocation_id TEXT NOT NULL,
          interrupt_id TEXT NOT NULL, data TEXT NOT NULL,
          UNIQUE(pet_id, session_id, invocation_id, interrupt_id)
        );
        CREATE INDEX IF NOT EXISTS channel_interrupt_history ON channel_interrupt_notifications(channel_id, sequence);
        CREATE TABLE IF NOT EXISTS channel_executions (
          sequence INTEGER PRIMARY KEY AUTOINCREMENT, execution_id TEXT UNIQUE NOT NULL,
          channel_id TEXT NOT NULL, invocation_id TEXT UNIQUE, data TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS channel_execution_history ON channel_executions(channel_id, sequence);
        PRAGMA user_version=4;
      `);
      this.observerId = randomUUID();
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
  sendMessage(channelId: string, input: unknown, author: ChannelAuthor, source?: ChannelMessageSource): ChannelMessage {
    const message = channelMessageSchema.parse(input);
    const trustedAuthor = channelAuthorSchema.parse(author);
    const seen = new Set<string>();
    if (message.mentions.some(({ petId }) => seen.has(petId) || !seen.add(petId))) throw new Error('Duplicate mention.');
    const entry = this.transaction(() => {
      const channel = this.getChannel(channelId);
      if (message.replyTo) this.getMessage(channel.channelId, message.replyTo);
      if (source && (source.petId !== trustedAuthor.id || trustedAuthor.kind !== 'pet'
        || this.getBinding(channelId, source.petId)?.sessionId !== source.sessionId)) throw new Error('Message source does not match Channel binding.');
      return this.append({ ...message, ...(source ? { source } : {}), kind: 'message', channelId: channel.channelId,
        messageId: randomUUID(), revision: channel.sequence, author: trustedAuthor, occurredAt: new Date().toISOString(),
      });
    }) as ChannelMessage;
    return this.publish(entry);
  }
  private decodeBinding(row: unknown): ChannelSessionBinding | null {
    if (!row) return null;
    const value = row as { channel_id: string; pet_id: string; session_id: string; registered: number };
    return { channelId: value.channel_id, petId: value.pet_id, sessionId: value.session_id, registered: !!value.registered };
  }
  getBinding(channelId: string, petId: string): ChannelSessionBinding | null {
    return this.decodeBinding(this.database().prepare('SELECT * FROM channel_sessions WHERE channel_id=? AND pet_id=?').get(identifier.parse(channelId), petId));
  }
  listBindings(channelId: string): ChannelSessionBinding[] {
    const channel = this.getChannel(channelId);
    return this.database().prepare('SELECT * FROM channel_sessions WHERE channel_id=? ORDER BY pet_id')
      .all(channel.channelId).map(row => this.decodeBinding(row)!);
  }
  findBinding(petId: string, sessionId: string): ChannelSessionBinding | null {
    return this.decodeBinding(this.database().prepare('SELECT * FROM channel_sessions WHERE pet_id=? AND session_id=?').get(petId, sessionId));
  }
  reserveBinding(channelId: string, petId: string, allocate: () => string): ChannelSessionBinding {
    return this.transaction(() => {
      channelId = this.getChannel(channelId).channelId;
      identifier.parse(petId);
      const existing = this.getBinding(channelId, petId);
      if (existing) return existing;
      const sessionId = identifier.parse(allocate());
      this.database().prepare('INSERT INTO channel_sessions(channel_id, pet_id, session_id) VALUES (?, ?, ?)').run(channelId, petId, sessionId);
      return this.getBinding(channelId, petId)!;
    });
  }
  confirmBinding(binding: ChannelSessionBinding): void {
    const result = this.database().prepare('UPDATE channel_sessions SET registered=1 WHERE channel_id=? AND pet_id=? AND session_id=?')
      .run(identifier.parse(binding.channelId), binding.petId, binding.sessionId);
    if (result.changes !== 1) throw new Error('Channel session binding changed.');
  }
  private requireOutputBinding(channelId: string, source: ChannelMessageSource): ChannelSessionBinding {
    const binding = this.getBinding(channelId, source.petId);
    if (!binding || binding.sessionId !== source.sessionId) throw new Error('Output destination does not match Channel binding.');
    return binding;
  }
  recordOutput(channelId: string, source: ChannelMessageSource, body: string): ChannelMessage {
    const binding = this.requireOutputBinding(channelId, source);
    let created = false;
    const entry = this.transaction(() => {
      const saved = this.database().prepare('SELECT message_id FROM channel_outputs WHERE pet_id=? AND session_id=? AND invocation_id=?')
        .get(source.petId, source.sessionId, source.invocationId) as { message_id: string } | undefined;
      if (saved) return this.getMessage(binding.channelId, saved.message_id);
      const channel = this.getChannel(binding.channelId);
      const message = this.append({ ...channelMessageSchema.parse({ body }), kind: 'message',
        channelId: channel.channelId, messageId: randomUUID(), revision: channel.sequence,
        author: { kind: 'pet', id: source.petId }, source, occurredAt: new Date().toISOString(),
      }) as ChannelMessage;
      this.database().prepare('INSERT INTO channel_outputs VALUES (?, ?, ?, ?)')
        .run(source.petId, source.sessionId, source.invocationId, message.messageId);
      created = true;
      return message;
    });
    return created ? this.publish(entry) : entry;
  }
  recordInterrupt(channelId: string, source: ChannelMessageSource, value: unknown): ChannelInterruptNotification {
    const binding = this.requireOutputBinding(channelId, source);
    const pendingInterrupt = parsePendingInterruptProjection(value);
    if (!pendingInterrupt) throw new Error('Invalid public pending interrupt projection.');
    return this.transaction(() => {
      const data = { channelId: binding.channelId, source, occurredAt: new Date().toISOString(), pendingInterrupt };
      this.database().prepare(`INSERT OR IGNORE INTO channel_interrupt_notifications
        (channel_id, pet_id, session_id, invocation_id, interrupt_id, data) VALUES (?, ?, ?, ?, ?, ?)`)
        .run(binding.channelId, source.petId, source.sessionId, source.invocationId, pendingInterrupt.interruptId, JSON.stringify(data));
      const row = this.database().prepare(`SELECT sequence, data FROM channel_interrupt_notifications
        WHERE pet_id=? AND session_id=? AND invocation_id=? AND interrupt_id=?`)
        .get(source.petId, source.sessionId, source.invocationId, pendingInterrupt.interruptId) as { sequence: number; data: string };
      return { ...JSON.parse(row.data), sequence: row.sequence };
    });
  }
  /** Operator-only history: deliberately absent from readContext and message history. */
  readInterruptNotifications(channelId: string, page: unknown = {}) {
    const { after, limit } = channelPageSchema.parse(page);
    const channel = this.getChannel(channelId);
    const rows = this.database().prepare(`SELECT sequence, data FROM channel_interrupt_notifications
      WHERE channel_id=? AND sequence>? ORDER BY sequence LIMIT ?`).all(channel.channelId, after, limit + 1) as { sequence: number; data: string }[];
    const notifications: ChannelInterruptNotification[] = rows.slice(0, limit).map(row => {
      const data = JSON.parse(row.data);
      const pendingInterrupt = parsePendingInterruptProjection(data.pendingInterrupt);
      if (!pendingInterrupt) {
        throw new Error(`Unsupported Channel interrupt notification ${row.sequence}. The original record has been preserved.`);
      }
      return { ...data, pendingInterrupt, sequence: row.sequence };
    });
    return { notifications, nextAfter: notifications.at(-1)?.sequence ?? after, hasMore: rows.length > limit };
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
    return this.transaction(() => ({ channel: this.getChannel(channelId), history: this.readHistory(channelId, page), sessions: this.listBindings(channelId) }), true);
  }

  private saveExecution(value: ChannelExecution): ChannelExecution {
    this.database().prepare(`INSERT INTO channel_executions(execution_id, channel_id, invocation_id, data)
      VALUES (?, ?, ?, ?) ON CONFLICT(execution_id) DO UPDATE SET invocation_id=excluded.invocation_id, data=excluded.data`)
      .run(value.executionId, value.channelId, value.invocationId ?? null, JSON.stringify(value));
    return value;
  }
  private executionRow(executionId: string): ChannelExecution | null {
    const row = this.database().prepare('SELECT data FROM channel_executions WHERE execution_id=?').get(executionId) as { data: string } | undefined;
    return row ? JSON.parse(row.data) : null;
  }
  beginExecution(channelId: string, source: { petId: string; sessionId: string }, messageId: string): ChannelExecution {
    const binding = this.requireOutputBinding(channelId, { ...source, invocationId: '' });
    this.getMessage(binding.channelId, messageId);
    return this.saveExecution({ petId: source.petId, sessionId: source.sessionId, channelId: binding.channelId, executionId: messageId, messageId,
      state: 'admitting', occurredAt: new Date().toISOString(), observerId: this.observerId });
  }
  acceptExecution(messageId: string, invocationId: string): ChannelExecution {
    return this.transaction(() => {
      const pending = this.executionRow(messageId);
      if (!pending) throw new Error('Unknown Channel execution request.');
      const observed = this.database().prepare('SELECT execution_id, data FROM channel_executions WHERE invocation_id=?')
        .get(invocationId) as { execution_id: string; data: string } | undefined;
      if (observed && observed.execution_id !== messageId) {
        const value = JSON.parse(observed.data) as ChannelExecution;
        if (value.channelId !== pending.channelId || value.petId !== pending.petId || value.sessionId !== pending.sessionId) {
          throw new Error('Channel execution receipt does not match its observation.');
        }
        this.database().prepare('DELETE FROM channel_executions WHERE execution_id=?').run(observed.execution_id);
        return this.saveExecution({ ...pending, ...value, executionId: messageId, messageId });
      }
      return this.saveExecution({ ...pending, invocationId, state: pending.state === 'admitting' ? 'queued' : pending.state });
    });
  }
  failExecution(messageId: string, error: string): void {
    const value = this.executionRow(messageId);
    if (!value) throw new Error('Unknown Channel execution request.');
    this.saveExecution({ ...value, state: 'failed', error, occurredAt: new Date().toISOString() });
  }
  recordExecution(channelId: string, source: ChannelMessageSource, state: Exclude<ChannelExecutionState, 'admitting'>, occurredAt: string, error?: string): ChannelExecution {
    const binding = this.requireOutputBinding(channelId, source);
    const row = this.database().prepare('SELECT data FROM channel_executions WHERE invocation_id=?').get(source.invocationId) as { data: string } | undefined;
    const existing = row ? JSON.parse(row.data) as ChannelExecution : null;
    if (existing && (existing.channelId !== binding.channelId || existing.petId !== source.petId || existing.sessionId !== source.sessionId)) {
      throw new Error('Channel execution identity does not match its original observation.');
    }
    if (existing && ['waiting', 'completed', 'interrupted', 'failed'].includes(existing.state)) return existing;
    return this.saveExecution({ ...(existing ?? {}), ...source, channelId: binding.channelId,
      executionId: existing?.executionId ?? `dispatch:${source.invocationId}`, state, occurredAt,
      ...(error ? { error } : {}), observerId: this.observerId });
  }
  recordDeliveryFailure(invocationId: string, error: string): void {
    const row = this.database().prepare('SELECT data FROM channel_executions WHERE invocation_id=?').get(invocationId) as { data: string } | undefined;
    if (row) this.saveExecution({ ...JSON.parse(row.data), deliveryError: error });
  }
  readExecutions(channelId: string, page: unknown = {}) {
    const { after, limit } = channelPageSchema.parse(page);
    const channel = this.getChannel(channelId);
    const rows = this.database().prepare('SELECT sequence, data FROM channel_executions WHERE channel_id=? AND sequence>? ORDER BY sequence LIMIT ?')
      .all(channel.channelId, after, limit + 1) as { sequence: number; data: string }[];
    const executions = rows.slice(0, limit).map(row => {
      const { observerId, ...value } = JSON.parse(row.data) as ChannelExecution;
      return { ...value, sequence: row.sequence,
        observationLost: observerId !== this.observerId && ['admitting', 'queued', 'running', 'waiting'].includes(value.state) };
    });
    return { executions, nextAfter: executions.at(-1)?.sequence ?? after, hasMore: rows.length > limit };
  }
}
