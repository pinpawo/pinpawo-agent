import { chmodSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type {
  ChannelMemberRow, ChannelMessageRow, ChannelRow, ChannelSessionRow, ChannelStore, MemberRef, Page, PageOf,
} from './channelStore';

const SCHEMA_VERSION = 1;

type ChannelRecord = {
  rowid: number; channel_id: string; title: string; description: string | null;
  created_by_kind: MemberRef['kind']; created_by_id: string; created_at: string; updated_at: string;
};
type MemberRecord = { channel_id: string; member_kind: MemberRef['kind']; member_id: string; joined_at: string; left_at: string | null };
type MessageRecord = {
  sequence: number; message_id: string; channel_id: string; author_kind: MemberRef['kind']; author_id: string;
  occurred_at: string; external_ref: string | null; data: string;
};
type SessionRecord = { channel_id: string; pet_id: string; session_id: string; registered: number };

function channelRow(record: ChannelRecord): ChannelRow {
  return {
    channelId: record.channel_id, title: record.title,
    ...(record.description === null ? {} : { description: record.description }),
    createdBy: { kind: record.created_by_kind, id: record.created_by_id },
    createdAt: record.created_at, updatedAt: record.updated_at,
  };
}
function memberRow(record: MemberRecord): ChannelMemberRow {
  return {
    channelId: record.channel_id, kind: record.member_kind, id: record.member_id, joinedAt: record.joined_at,
    ...(record.left_at === null ? {} : { leftAt: record.left_at }),
  };
}
function messageRow(record: MessageRecord): ChannelMessageRow {
  const data = JSON.parse(record.data) as Pick<ChannelMessageRow, 'body' | 'replyTo' | 'mentions' | 'artifacts'>;
  return {
    sequence: record.sequence, messageId: record.message_id, channelId: record.channel_id,
    author: { kind: record.author_kind, id: record.author_id }, occurredAt: record.occurred_at,
    ...(record.external_ref === null ? {} : { externalRef: record.external_ref }),
    ...data,
  };
}
function sessionRow(record: SessionRecord): ChannelSessionRow {
  return { channelId: record.channel_id, petId: record.pet_id, sessionId: record.session_id, registered: !!record.registered };
}
function paged<T>(rows: T[], limit: number, after: number, cursor: (row: T) => number): PageOf<T> {
  const items = rows.slice(0, limit);
  return { items, nextAfter: items.length ? cursor(items.at(-1)!) : after, hasMore: rows.length > limit };
}

/** The default ChannelStore: one SQLite file owned by the Channel Plugin. */
export class SqliteChannelStore implements ChannelStore {
  private db: DatabaseSync | undefined;

  constructor(private readonly databasePath: string = ':memory:') {}

  init(): void {
    if (this.db) return;
    if (this.databasePath !== ':memory:') mkdirSync(path.dirname(this.databasePath), { recursive: true });
    const db = new DatabaseSync(this.databasePath);
    try {
      if (this.databasePath !== ':memory:') chmodSync(this.databasePath, 0o600);
      db.exec('PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;');
      const version = (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
      if (version !== 0 && version !== SCHEMA_VERSION) throw new Error(`Unsupported Channel schema version ${version}.`);
      db.exec(`
        CREATE TABLE IF NOT EXISTS channels (
          channel_id      TEXT PRIMARY KEY,
          title           TEXT NOT NULL,
          description     TEXT,
          created_by_kind TEXT NOT NULL CHECK(created_by_kind IN ('human','pet')),
          created_by_id   TEXT NOT NULL,
          created_at      TEXT NOT NULL,
          updated_at      TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS channel_members (
          channel_id  TEXT NOT NULL REFERENCES channels(channel_id),
          member_kind TEXT NOT NULL CHECK(member_kind IN ('human','pet')),
          member_id   TEXT NOT NULL,
          joined_at   TEXT NOT NULL,
          left_at     TEXT,
          PRIMARY KEY(channel_id, member_kind, member_id)
        );
        CREATE INDEX IF NOT EXISTS channel_members_by_member ON channel_members(member_kind, member_id) WHERE left_at IS NULL;
        CREATE TABLE IF NOT EXISTS channel_messages (
          sequence     INTEGER PRIMARY KEY AUTOINCREMENT,
          message_id   TEXT NOT NULL UNIQUE,
          channel_id   TEXT NOT NULL REFERENCES channels(channel_id),
          author_kind  TEXT NOT NULL CHECK(author_kind IN ('human','pet')),
          author_id    TEXT NOT NULL,
          occurred_at  TEXT NOT NULL,
          external_ref TEXT,
          data         TEXT NOT NULL,
          UNIQUE(author_kind, author_id, external_ref)
        );
        CREATE INDEX IF NOT EXISTS channel_message_history ON channel_messages(channel_id, sequence);
        CREATE TABLE IF NOT EXISTS channel_sessions (
          channel_id TEXT NOT NULL REFERENCES channels(channel_id),
          pet_id     TEXT NOT NULL,
          session_id TEXT NOT NULL,
          registered INTEGER NOT NULL DEFAULT 0,
          PRIMARY KEY(channel_id, pet_id), UNIQUE(pet_id, session_id)
        );
        PRAGMA user_version=${SCHEMA_VERSION};
      `);
      this.db = db;
    } catch (error) { db.close(); throw error; }
  }

  close(): void { this.db?.close(); this.db = undefined; }

  private database(): DatabaseSync {
    if (!this.db) throw new Error('Channel store is not started.');
    return this.db;
  }

  transaction<T>(run: () => T): T {
    const db = this.database();
    if (db.isTransaction) return run();
    db.exec('BEGIN IMMEDIATE');
    try { const result = run(); db.exec('COMMIT'); return result; }
    catch (error) { db.exec('ROLLBACK'); throw error; }
  }

  createChannel(row: ChannelRow): void {
    this.database().prepare(`INSERT INTO channels(channel_id, title, description, created_by_kind, created_by_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`).run(row.channelId, row.title, row.description ?? null,
      row.createdBy.kind, row.createdBy.id, row.createdAt, row.updatedAt);
  }

  updateChannel(channelId: string, patch: { title?: string; description?: string | null; updatedAt: string }): void {
    const current = this.getChannel(channelId);
    if (!current) throw new Error(`Unknown Channel "${channelId}".`);
    this.database().prepare('UPDATE channels SET title=?, description=?, updated_at=? WHERE channel_id=?').run(
      patch.title ?? current.title,
      patch.description === undefined ? current.description ?? null : patch.description,
      patch.updatedAt, channelId,
    );
  }

  getChannel(channelId: string): ChannelRow | undefined {
    const record = this.database().prepare('SELECT rowid, * FROM channels WHERE channel_id=?').get(channelId) as ChannelRecord | undefined;
    return record ? channelRow(record) : undefined;
  }

  listChannels(filter: { member?: MemberRef }, { after, limit }: Page): PageOf<ChannelRow> {
    const records = (filter.member
      ? this.database().prepare(`SELECT c.rowid, c.* FROM channels c JOIN channel_members m ON m.channel_id=c.channel_id
          WHERE m.member_kind=? AND m.member_id=? AND m.left_at IS NULL AND c.rowid>? ORDER BY c.rowid LIMIT ?`)
        .all(filter.member.kind, filter.member.id, after, limit + 1)
      : this.database().prepare('SELECT rowid, * FROM channels WHERE rowid>? ORDER BY rowid LIMIT ?').all(after, limit + 1)) as ChannelRecord[];
    const page = paged(records, limit, after, record => record.rowid);
    return { ...page, items: page.items.map(channelRow) };
  }

  listMembers(channelId: string): ChannelMemberRow[] {
    return (this.database().prepare('SELECT * FROM channel_members WHERE channel_id=? ORDER BY joined_at, member_kind, member_id')
      .all(channelId) as MemberRecord[]).map(memberRow);
  }

  upsertMember(row: ChannelMemberRow): void {
    this.database().prepare(`INSERT INTO channel_members(channel_id, member_kind, member_id, joined_at, left_at) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(channel_id, member_kind, member_id) DO UPDATE SET joined_at=excluded.joined_at, left_at=excluded.left_at`)
      .run(row.channelId, row.kind, row.id, row.joinedAt, row.leftAt ?? null);
  }

  appendMessage(row: Omit<ChannelMessageRow, 'sequence'>): ChannelMessageRow {
    return this.transaction(() => {
      if (row.externalRef !== undefined) {
        const existing = this.database().prepare('SELECT * FROM channel_messages WHERE author_kind=? AND author_id=? AND external_ref=?')
          .get(row.author.kind, row.author.id, row.externalRef) as MessageRecord | undefined;
        if (existing) return messageRow(existing);
      }
      const { body, replyTo, mentions, artifacts } = row;
      const result = this.database().prepare(`INSERT INTO channel_messages(message_id, channel_id, author_kind, author_id, occurred_at, external_ref, data)
        VALUES (?, ?, ?, ?, ?, ?, ?)`).run(row.messageId, row.channelId, row.author.kind, row.author.id, row.occurredAt,
        row.externalRef ?? null, JSON.stringify({ body, ...(replyTo ? { replyTo } : {}), mentions, artifacts }));
      return { ...row, sequence: Number(result.lastInsertRowid) };
    });
  }

  getMessage(channelId: string, messageId: string): ChannelMessageRow | undefined {
    const record = this.database().prepare('SELECT * FROM channel_messages WHERE channel_id=? AND message_id=?')
      .get(channelId, messageId) as MessageRecord | undefined;
    return record ? messageRow(record) : undefined;
  }

  readMessages(channelId: string, { after, limit }: Page): PageOf<ChannelMessageRow> {
    const records = this.database().prepare('SELECT * FROM channel_messages WHERE channel_id=? AND sequence>? ORDER BY sequence LIMIT ?')
      .all(channelId, after, limit + 1) as MessageRecord[];
    const page = paged(records, limit, after, record => record.sequence);
    return { ...page, items: page.items.map(messageRow) };
  }

  getSession(channelId: string, petId: string): ChannelSessionRow | undefined {
    const record = this.database().prepare('SELECT * FROM channel_sessions WHERE channel_id=? AND pet_id=?')
      .get(channelId, petId) as SessionRecord | undefined;
    return record ? sessionRow(record) : undefined;
  }

  reserveSession(row: ChannelSessionRow): ChannelSessionRow {
    return this.transaction(() => {
      const existing = this.getSession(row.channelId, row.petId);
      if (existing) return existing;
      this.database().prepare('INSERT INTO channel_sessions(channel_id, pet_id, session_id, registered) VALUES (?, ?, ?, ?)')
        .run(row.channelId, row.petId, row.sessionId, row.registered ? 1 : 0);
      return { ...row };
    });
  }

  confirmSession(row: ChannelSessionRow): void {
    const result = this.database().prepare('UPDATE channel_sessions SET registered=1 WHERE channel_id=? AND pet_id=? AND session_id=?')
      .run(row.channelId, row.petId, row.sessionId);
    if (result.changes !== 1) throw new Error('Channel session binding changed.');
  }

  listSessions(channelId: string): ChannelSessionRow[] {
    return (this.database().prepare('SELECT * FROM channel_sessions WHERE channel_id=? ORDER BY pet_id')
      .all(channelId) as SessionRecord[]).map(sessionRow);
  }
}
