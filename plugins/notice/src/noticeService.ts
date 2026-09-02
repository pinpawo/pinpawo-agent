import { randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export type NoticeLevel = 'info' | 'warning' | 'error';

export type Notice = {
  noticeId: string;
  ruleId: string;
  level: NoticeLevel;
  title: string;
  source: string;
  eventType: string;
  payload?: unknown;
  occurredAt: string;
};

type NoticeRow = {
  notice_id: string;
  rule_id: string;
  level: NoticeLevel;
  title: string;
  source: string;
  event_type: string;
  payload_json: string | null;
  occurred_at: string;
};

const LEVELS = new Set<NoticeLevel>(['info', 'warning', 'error']);

function nonEmpty(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`Notice ${label} must not be empty.`);
  return normalized;
}

function payloadText(payload: unknown): string | null {
  if (payload === undefined) return null;
  try {
    return JSON.stringify(payload) ?? 'null';
  } catch {
    return JSON.stringify({ unavailable: 'Notice payload was not serializable.' });
  }
}

function noticeFromRow(row: NoticeRow): Notice {
  if (!LEVELS.has(row.level)) throw new Error(`Notice database contains unsupported level "${row.level}".`);
  let payload: unknown;
  if (row.payload_json !== null) {
    try {
      payload = JSON.parse(row.payload_json) as unknown;
    } catch {
      throw new Error(`Notice database contains invalid payload for "${row.notice_id}".`);
    }
  }
  return {
    noticeId: row.notice_id,
    ruleId: row.rule_id,
    level: row.level,
    title: row.title,
    source: row.source,
    eventType: row.event_type,
    ...(row.payload_json === null ? {} : { payload }),
    occurredAt: row.occurred_at,
  };
}

export class NoticeService {
  private readonly database: DatabaseSync;
  private readonly listeners = new Set<(notice: Notice) => void>();
  private initialized = false;
  private closed = false;

  constructor(databasePath = ':memory:') {
    if (databasePath !== ':memory:' && !path.isAbsolute(databasePath)) {
      throw new Error('Notice databasePath must be absolute or :memory:.');
    }
    if (databasePath !== ':memory:') {
      const directory = path.dirname(databasePath);
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      chmodSync(directory, 0o700);
    }
    this.database = new DatabaseSync(databasePath, { timeout: 5_000 });
  }

  async init(): Promise<void> {
    if (this.closed) throw new Error('Notice service is closed.');
    if (this.initialized) return;
    this.database.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = FULL;
      PRAGMA busy_timeout = 5000;
      PRAGMA trusted_schema = OFF;
      CREATE TABLE IF NOT EXISTS notices (
        notice_id TEXT PRIMARY KEY,
        rule_id TEXT NOT NULL,
        level TEXT NOT NULL CHECK (level IN ('info','warning','error')),
        title TEXT NOT NULL,
        source TEXT NOT NULL,
        event_type TEXT NOT NULL,
        payload_json TEXT,
        occurred_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS notices_recent ON notices(occurred_at DESC, notice_id DESC);
    `);
    this.initialized = true;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.listeners.clear();
    this.closed = true;
    this.database.close();
  }

  subscribe(listener: (notice: Notice) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async create(input: Omit<Notice, 'noticeId' | 'occurredAt'> & { occurredAt?: string }): Promise<Notice> {
    this.assertReady();
    if (!LEVELS.has(input.level)) throw new Error(`Notice level "${input.level}" is unsupported.`);
    const notice: Notice = {
      noticeId: randomUUID(),
      ruleId: nonEmpty(input.ruleId, 'ruleId'),
      level: input.level,
      title: nonEmpty(input.title, 'title'),
      source: nonEmpty(input.source, 'source'),
      eventType: nonEmpty(input.eventType, 'eventType'),
      ...(input.payload === undefined ? {} : { payload: input.payload }),
      occurredAt: input.occurredAt ?? new Date().toISOString(),
    };
    this.database.prepare(`
      INSERT INTO notices(notice_id, rule_id, level, title, source, event_type, payload_json, occurred_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      notice.noticeId,
      notice.ruleId,
      notice.level,
      notice.title,
      notice.source,
      notice.eventType,
      payloadText(notice.payload),
      notice.occurredAt,
    );
    for (const listener of this.listeners) {
      try {
        listener(notice);
      } catch (error) {
        console.error('[notice] committed notice listener failed:', error);
      }
    }
    return notice;
  }

  async snapshot(limit = 100): Promise<{ notices: Notice[] }> {
    this.assertReady();
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) {
      throw new Error('Notice limit must be from 1 to 1000.');
    }
    const rows = this.database.prepare(`
      SELECT * FROM notices ORDER BY occurred_at DESC, notice_id DESC LIMIT ?
    `).all(limit) as NoticeRow[];
    return { notices: rows.map(noticeFromRow) };
  }

  private assertReady(): void {
    if (!this.initialized || this.closed) throw new Error('Notice service is not active.');
  }
}
