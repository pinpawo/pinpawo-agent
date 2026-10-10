import { parsePendingInterruptProjection, type AgentMessageToolCall, type PendingInterruptProjection } from '@pinpawo/agent-session';
import { randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { channelMentionSchema, channelMentionId, type ChannelMention } from './channelParticipants';

const identifier = z.string().trim().min(1).max(256);
export const channelAuthorSchema = z.object({
  kind: z.enum(['human', 'pet']),
  actorId: identifier.optional(),
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
  mentions: z.array(channelMentionSchema).max(100).default([]),
  artifacts: z.array(artifactReferenceSchema).max(100).default([]),
}).strict();
export const channelPageSchema = z.object({
  after: z.number().int().nonnegative().safe().default(0),
  limit: z.number().int().min(1).max(200).default(50),
}).strict();
export type ChannelAuthor = z.infer<typeof channelAuthorSchema>;
/** Old journal sources remain readable, never new addressable members. */
export type ChannelStoredAuthor = ChannelAuthor | { kind: 'bot'; id: string };
export type ChannelMember = { kind: 'human' | 'pet'; id: string; active: boolean };
export type ChannelUser = { id: string; label: string };
export type ChannelRevision = z.infer<typeof channelGoalSchema> & {
  kind: 'revision'; channelId: string; sequence: number; author: ChannelStoredAuthor;
  occurredAt: string; reason: string; sourceMessageId?: string;
};
export type ChannelSessionBinding = { channelId: string; petId: string; sessionId: string; registered: boolean };
export type ChannelMessageSource = { petId: string; sessionId: string; invocationId: string };
/** A Pet conversation message that called tools, as Agent Session carries it. */
export const channelToolCallMessageSchema = z.object({
  messageId: identifier,
  text: z.string().max(100_000),
  toolCalls: z.array(z.object({ id: identifier, name: identifier, args: z.record(z.unknown()) }).strict()).min(1).max(100),
}).strict();
export const channelToolCallSettlementSchema = z.object({
  messageId: identifier,
  callId: identifier,
  status: z.enum(['completed', 'failed']),
  // Carried with a failure; Channel records only the outcome.
  error: z.string().optional(),
}).strict();
export type ChannelToolCall = AgentMessageToolCall;
export type ChannelMessage = z.infer<typeof channelMessageSchema> & {
  source?: ChannelMessageSource;
  /** Tools the Pet called in this message, in their own shape; the body may then be empty. */
  toolCalls?: ChannelToolCall[];
  kind: 'message'; channelId: string; sequence: number; messageId: string;
  author: ChannelStoredAuthor; occurredAt: string; revision: number;
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
  private defaultMembers: ChannelMember[] = [];
  private inputUsers: Record<string, string> = {};
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
      if (![0, 1, 2, 3, 4, 5, 6].includes(version)) throw new Error(`Unsupported Channel schema version ${version}.`);
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
        CREATE TABLE IF NOT EXISTS channel_tool_call_messages (
          pet_id TEXT NOT NULL, session_id TEXT NOT NULL, session_message_id TEXT NOT NULL,
          invocation_id TEXT NOT NULL, message_id TEXT NOT NULL,
          PRIMARY KEY(pet_id, session_id, session_message_id)
        );
        CREATE TABLE IF NOT EXISTS channel_tool_calls (
          message_id TEXT NOT NULL, call_id TEXT NOT NULL, status TEXT NOT NULL,
          PRIMARY KEY(message_id, call_id)
        );
        CREATE TABLE IF NOT EXISTS channel_users (id TEXT PRIMARY KEY, label TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS channel_members (
          channel_id TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('human', 'pet')),
          id TEXT NOT NULL, active INTEGER NOT NULL, PRIMARY KEY(channel_id, kind, id)
        );
        CREATE TABLE IF NOT EXISTS channel_members_initialized (channel_id TEXT PRIMARY KEY);
        PRAGMA user_version=6;
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
    const entry = { ...JSON.parse(value.data), sequence: value.sequence } as ChannelEntry;
    if (entry.author.kind === 'bot' && Object.hasOwn(this.inputUsers, entry.author.id)) {
      entry.author = { kind: 'human', id: this.inputUsers[entry.author.id]!, actorId: entry.author.id };
    }
    if (entry.kind !== 'message' || !entry.toolCalls) return entry;
    // The message is the journal's; each call's outcome is observed afterwards.
    const statuses = new Map((this.database().prepare('SELECT call_id, status FROM channel_tool_calls WHERE message_id=?')
      .all(entry.messageId) as { call_id: string; status: ChannelToolCall['status'] }[]).map(row => [row.call_id, row.status]));
    return { ...entry, toolCalls: entry.toolCalls.map(call => ({ ...call, status: statuses.get(call.id) ?? 'running' })) };
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
  configureMembers(operator: ChannelUser, pets: { petId: string }[], users: ChannelUser[] = [], inputUsers: Record<string, string> = {}): void {
    this.inputUsers = inputUsers;
    for (const user of [operator, ...users]) this.upsertUser(user);
    this.defaultMembers = [{ kind: 'human', id: operator.id, active: true },
      ...pets.map(pet => ({ kind: 'pet' as const, id: pet.petId, active: true }))];
  }
  upsertUser(user: ChannelUser): void {
    this.database().prepare('INSERT INTO channel_users(id,label) VALUES (?,?) ON CONFLICT(id) DO UPDATE SET label=excluded.label')
      .run(identifier.parse(user.id), z.string().trim().min(1).max(500).parse(user.label));
  }
  listUsers(): ChannelUser[] {
    return this.database().prepare('SELECT id,label FROM channel_users ORDER BY id').all() as ChannelUser[];
  }
  private initializeMembers(channelId: string, inTransaction = false): void {
    channelId = this.getChannel(channelId).channelId;
    if (this.database().prepare('SELECT 1 FROM channel_members_initialized WHERE channel_id=?').get(channelId)) return;
    const initialize = () => {
      if (this.database().prepare('SELECT 1 FROM channel_members_initialized WHERE channel_id=?').get(channelId)) return;
      const members = [...this.defaultMembers];
      const rows = this.database().prepare('SELECT data FROM channel_entries WHERE channel_id=?').all(channelId) as { data: string }[];
      for (const row of rows) {
        const author = JSON.parse(row.data).author as ChannelStoredAuthor;
        if (author.kind === 'pet') members.push({ kind: 'pet', id: author.id, active: true });
        if (author.kind === 'bot' && Object.hasOwn(this.inputUsers, author.id)) members.push({ kind: 'human', id: this.inputUsers[author.id]!, active: true });
        if (author.kind === 'human') {
          members.push({ kind: 'human', id: author.id, active: true });
          this.database().prepare('INSERT OR IGNORE INTO channel_users(id,label) VALUES (?,?)').run(author.id, author.id);
        }
      }
      for (const row of this.database().prepare('SELECT pet_id FROM channel_sessions WHERE channel_id=?').all(channelId) as { pet_id: string }[]) members.push({ kind: 'pet', id: row.pet_id, active: true });
      for (const member of members) this.database().prepare('INSERT OR IGNORE INTO channel_members VALUES (?,?,?,?)')
        .run(channelId, member.kind, member.id, 1);
      this.database().prepare('INSERT INTO channel_members_initialized VALUES (?)').run(channelId);
    };
    if (inTransaction) initialize(); else this.transaction(initialize);
  }
  listMembers(channelId: string): ChannelMember[] {
    channelId = this.getChannel(channelId).channelId;
    this.initializeMembers(channelId);
    return (this.database().prepare('SELECT kind,id,active FROM channel_members WHERE channel_id=? ORDER BY kind,id')
      .all(channelId) as { kind: ChannelMember['kind']; id: string; active: number }[]).map(member => ({ ...member, active: !!member.active }));
  }
  requireMember(channelId: string, author: ChannelAuthor): void {
    if (!this.listMembers(channelId).some(member => member.active && member.kind === author.kind && member.id === author.id)) {
      throw new Error('Channel membership required.');
    }
  }
  setMember(channelId: string, member: ChannelMember): void {
    channelId = this.getChannel(channelId).channelId;
    this.initializeMembers(channelId);
    if (member.kind === 'human' && !this.listUsers().some(user => user.id === member.id)) throw new Error('Unknown Channel user.');
    this.database().prepare('INSERT INTO channel_members VALUES (?,?,?,?) ON CONFLICT(channel_id,kind,id) DO UPDATE SET active=excluded.active')
      .run(channelId, z.enum(['human', 'pet']).parse(member.kind), identifier.parse(member.id), member.active ? 1 : 0);
  }
  getChannel(channelId: string): ChannelRevision {
    const id = identifier.parse(channelId);
    const entry = this.decode(this.database().prepare(
      "SELECT sequence, data FROM channel_entries WHERE channel_id=? AND kind='revision' ORDER BY sequence DESC LIMIT 1",
    ).get(id));
    if (!entry) throw new Error(`Unknown Channel "${id}".`);
    return entry as ChannelRevision;
  }
  listChannels(page: unknown = {}, userId?: string): { channels: ChannelRevision[]; nextAfter: number; hasMore: boolean } {
    const { after, limit } = channelPageSchema.parse(page);
    if (userId) for (const row of this.database().prepare('SELECT DISTINCT e.channel_id FROM channel_entries e WHERE NOT EXISTS (SELECT 1 FROM channel_members_initialized m WHERE m.channel_id=e.channel_id)').all() as { channel_id: string }[]) this.initializeMembers(row.channel_id);
    // Page by immutable creation sequence; revisions cannot move a Channel across pages.
    const rows = this.database().prepare(`SELECT MIN(sequence) AS created, channel_id FROM channel_entries
      WHERE kind='revision' AND (? IS NULL OR EXISTS (SELECT 1 FROM channel_members m WHERE m.channel_id=channel_entries.channel_id AND m.kind='human' AND m.id=? AND m.active=1)) GROUP BY channel_id HAVING MIN(sequence)>? ORDER BY created LIMIT ?`).all(userId ?? null, userId ?? null, after, limit + 1) as { created: number; channel_id: string }[];
    const selected = rows.slice(0, limit);
    return { channels: selected.map((row) => this.getChannel(row.channel_id)), nextAfter: selected.at(-1)?.created ?? after, hasMore: rows.length > limit };
  }
  createChannel(input: unknown, author: ChannelAuthor): ChannelRevision {
    const goal = channelGoalSchema.parse(input);
    const trustedAuthor = channelAuthorSchema.parse(author);
    const entry = this.transaction(() => {
      const created = this.append({ ...goal, kind: 'revision', channelId: randomUUID(), author: trustedAuthor,
        occurredAt: new Date().toISOString(), reason: 'created' }) as ChannelRevision;
      if (trustedAuthor.kind === 'human') this.database().prepare('INSERT OR IGNORE INTO channel_users(id,label) VALUES (?,?)').run(trustedAuthor.id, trustedAuthor.id);
      if (this.defaultMembers.length) this.initializeMembers(created.channelId, true);
      return created;
    });
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
    message.mentions = message.mentions.filter(mention => {
      const id = channelMentionId(mention);
      if (seen.has(id)) return false;
      seen.add(id); return true;
    });
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
  recordOutput(channelId: string, source: ChannelMessageSource, body: string, mentions: ChannelMention[] = []): ChannelMessage {
    const binding = this.requireOutputBinding(channelId, source);
    let created = false;
    const entry = this.transaction(() => {
      const saved = this.database().prepare('SELECT message_id FROM channel_outputs WHERE pet_id=? AND session_id=? AND invocation_id=?')
        .get(source.petId, source.sessionId, source.invocationId) as { message_id: string } | undefined;
      if (saved) return this.getMessage(binding.channelId, saved.message_id);
      const channel = this.getChannel(binding.channelId);
      const message = this.append({ ...channelMessageSchema.parse({ body, mentions }), kind: 'message',
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
  /**
   * Record a conversation message in which the Pet called tools. It addresses
   * nobody; routing stays with the final reply. Idempotent per session message.
   */
  recordToolCallMessage(channelId: string, source: ChannelMessageSource, value: unknown): ChannelMessage {
    const binding = this.requireOutputBinding(channelId, source);
    const { messageId, text, toolCalls } = channelToolCallMessageSchema.parse(value);
    let created = false;
    const entry = this.transaction(() => {
      const saved = this.database().prepare('SELECT message_id FROM channel_tool_call_messages WHERE pet_id=? AND session_id=? AND session_message_id=?')
        .get(source.petId, source.sessionId, messageId) as { message_id: string } | undefined;
      if (saved) return this.getMessage(binding.channelId, saved.message_id);
      const channel = this.getChannel(binding.channelId);
      const message = this.append({ body: text.trim(), mentions: [], artifacts: [], toolCalls: toolCalls as ChannelToolCall[], kind: 'message',
        channelId: channel.channelId, messageId: randomUUID(), revision: channel.sequence,
        author: { kind: 'pet', id: source.petId }, source, occurredAt: new Date().toISOString(),
      }) as ChannelMessage;
      this.database().prepare('INSERT INTO channel_tool_call_messages VALUES (?, ?, ?, ?, ?)')
        .run(source.petId, source.sessionId, messageId, source.invocationId, message.messageId);
      created = true;
      return this.getMessage(binding.channelId, message.messageId);
    });
    return created ? this.publish(entry) : entry;
  }
  /** Record one call's outcome. A call this Channel never saw is not its to record. */
  settleToolCall(channelId: string, source: ChannelMessageSource, value: unknown): void {
    this.requireOutputBinding(channelId, source);
    const { messageId, callId, status } = channelToolCallSettlementSchema.parse(value);
    const saved = this.database().prepare('SELECT message_id FROM channel_tool_call_messages WHERE pet_id=? AND session_id=? AND session_message_id=?')
      .get(source.petId, source.sessionId, messageId) as { message_id: string } | undefined;
    if (!saved) return;
    this.database().prepare(`INSERT INTO channel_tool_calls VALUES (?, ?, ?)
      ON CONFLICT(message_id, call_id) DO UPDATE SET status=excluded.status`).run(saved.message_id, callId, status);
  }
  /** An invocation that stopped leaves its open calls interrupted. */
  interruptToolCalls(source: ChannelMessageSource): void {
    const db = this.database();
    const rows = db.prepare('SELECT message_id FROM channel_tool_call_messages WHERE pet_id=? AND session_id=? AND invocation_id=?')
      .all(source.petId, source.sessionId, source.invocationId) as { message_id: string }[];
    for (const { message_id } of rows) {
      const entry = this.decode(db.prepare("SELECT sequence, data FROM channel_entries WHERE message_id=? AND kind='message'").get(message_id));
      for (const call of entry?.kind === 'message' ? entry.toolCalls ?? [] : []) {
        if (call.status === 'running') db.prepare('INSERT OR IGNORE INTO channel_tool_calls VALUES (?, ?, ?)').run(message_id, call.id, 'interrupted');
      }
    }
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
  beginExecution(channelId: string, source: { petId: string; sessionId: string }, messageId: string, executionId = messageId): ChannelExecution {
    const binding = this.requireOutputBinding(channelId, { ...source, invocationId: '' });
    this.getMessage(binding.channelId, messageId);
    const existing = this.executionRow(executionId);
    if (existing) return existing;
    return this.saveExecution({ petId: source.petId, sessionId: source.sessionId, channelId: binding.channelId, executionId, messageId,
      state: 'admitting', occurredAt: new Date().toISOString(), observerId: this.observerId });
  }
  acceptExecution(executionId: string, invocationId: string): ChannelExecution {
    return this.transaction(() => {
      const pending = this.executionRow(executionId);
      if (!pending) throw new Error('Unknown Channel execution request.');
      const observed = this.database().prepare('SELECT execution_id, data FROM channel_executions WHERE invocation_id=?')
        .get(invocationId) as { execution_id: string; data: string } | undefined;
      if (observed && observed.execution_id !== executionId) {
        const value = JSON.parse(observed.data) as ChannelExecution;
        if (value.channelId !== pending.channelId || value.petId !== pending.petId || value.sessionId !== pending.sessionId) {
          throw new Error('Channel execution receipt does not match its observation.');
        }
        this.database().prepare('DELETE FROM channel_executions WHERE execution_id=?').run(observed.execution_id);
        return this.saveExecution({ ...pending, ...value, executionId, messageId: pending.messageId });
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
    // A waiting execution continues when its review is answered.
    if (existing && ['completed', 'interrupted', 'failed'].includes(existing.state)) return existing;
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
