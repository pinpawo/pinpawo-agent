import { randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export type ScheduleStatus = 'scheduled' | 'dispatching' | 'completed' | 'failed' | 'cancelled';

export type Schedule = {
  scheduleId: string;
  petId: string;
  request: string;
  runAt: string;
  status: ScheduleStatus;
  note?: string;
  createdAt: string;
  updatedAt: string;
};

export type ScheduleEvent = {
  sequence: number;
  scheduleId: string;
  eventType: 'created' | 'claimed' | 'completed' | 'failed' | 'cancelled' | 'recovered';
  status: ScheduleStatus;
  note?: string;
  occurredAt: string;
};

type ScheduleRow = {
  schedule_id: string;
  pet_id: string;
  request: string;
  run_at: string;
  status: string;
  note: string | null;
  created_at: string;
  updated_at: string;
};

type EventRow = {
  sequence: number;
  schedule_id: string;
  event_type: ScheduleEvent['eventType'];
  status: ScheduleStatus;
  note: string | null;
  occurred_at: string;
};

const STATUSES = new Set<ScheduleStatus>([
  'scheduled', 'dispatching', 'completed', 'failed', 'cancelled',
]);

function nonEmpty(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`Scheduler ${label} must not be empty.`);
  return normalized;
}

function parseDate(value: string, label: string): string {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) throw new Error(`Scheduler ${label} must be an ISO date.`);
  return new Date(timestamp).toISOString();
}

function scheduleFromRow(row: ScheduleRow): Schedule {
  if (!STATUSES.has(row.status as ScheduleStatus)) {
    throw new Error(`Scheduler database contains unsupported status "${row.status}".`);
  }
  return {
    scheduleId: row.schedule_id,
    petId: row.pet_id,
    request: row.request,
    runAt: row.run_at,
    status: row.status as ScheduleStatus,
    ...(row.note === null ? {} : { note: row.note }),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class SchedulerService {
  private readonly database: DatabaseSync;
  private initialized = false;
  private closed = false;

  constructor(databasePath = ':memory:') {
    if (databasePath !== ':memory:' && !path.isAbsolute(databasePath)) {
      throw new Error('Scheduler databasePath must be absolute or :memory:.');
    }
    if (databasePath !== ':memory:') {
      const directory = path.dirname(databasePath);
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      chmodSync(directory, 0o700);
    }
    this.database = new DatabaseSync(databasePath, {
      enableForeignKeyConstraints: true,
      timeout: 5_000,
    });
  }

  async init(): Promise<void> {
    if (this.closed) throw new Error('Scheduler service is closed.');
    if (this.initialized) return;
    this.database.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = FULL;
      PRAGMA busy_timeout = 5000;
      PRAGMA trusted_schema = OFF;
      BEGIN IMMEDIATE;
      CREATE TABLE IF NOT EXISTS schedules (
        schedule_id TEXT PRIMARY KEY,
        pet_id TEXT NOT NULL,
        request TEXT NOT NULL,
        run_at TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('scheduled','dispatching','completed','failed','cancelled')),
        note TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS schedule_events (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        schedule_id TEXT NOT NULL,
        event_type TEXT NOT NULL,
        status TEXT NOT NULL,
        note TEXT,
        occurred_at TEXT NOT NULL,
        FOREIGN KEY (schedule_id) REFERENCES schedules(schedule_id) ON DELETE RESTRICT
      );
      CREATE INDEX IF NOT EXISTS schedules_due ON schedules(status, run_at);
      COMMIT;
    `);
    this.initialized = true;
    this.recoverInterrupted();
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.database.close();
  }

  async create(input: { petId: string; request: string; runAt: string }): Promise<Schedule> {
    this.assertReady();
    const now = new Date().toISOString();
    const scheduleId = randomUUID();
    const petId = nonEmpty(input.petId, 'petId');
    const request = nonEmpty(input.request, 'request');
    const runAt = parseDate(input.runAt, 'runAt');
    this.database.exec('BEGIN IMMEDIATE;');
    try {
      this.database.prepare(`
        INSERT INTO schedules(schedule_id, pet_id, request, run_at, status, created_at, updated_at)
        VALUES (?, ?, ?, ?, 'scheduled', ?, ?)
      `).run(scheduleId, petId, request, runAt, now, now);
      this.insertEvent(scheduleId, 'created', 'scheduled', undefined, now);
      this.database.exec('COMMIT;');
    } catch (error) {
      this.database.exec('ROLLBACK;');
      throw error;
    }
    return this.get(scheduleId) as Promise<Schedule>;
  }

  async cancel(scheduleId: string): Promise<Schedule> {
    return this.transition(scheduleId, ['scheduled'], 'cancelled', 'cancelled');
  }

  async claimDue(now = new Date()): Promise<Schedule | null> {
    this.assertReady();
    this.database.exec('BEGIN IMMEDIATE;');
    try {
      const row = this.database.prepare(`
        SELECT * FROM schedules
        WHERE status = 'scheduled' AND run_at <= ?
        ORDER BY run_at, created_at LIMIT 1
      `).get(now.toISOString()) as ScheduleRow | undefined;
      if (!row) {
        this.database.exec('COMMIT;');
        return null;
      }
      const occurredAt = new Date().toISOString();
      this.database.prepare(
        "UPDATE schedules SET status = 'dispatching', updated_at = ? WHERE schedule_id = ?",
      ).run(occurredAt, row.schedule_id);
      this.insertEvent(row.schedule_id, 'claimed', 'dispatching', undefined, occurredAt);
      this.database.exec('COMMIT;');
      return this.get(row.schedule_id);
    } catch (error) {
      this.database.exec('ROLLBACK;');
      throw error;
    }
  }

  async complete(scheduleId: string): Promise<Schedule> {
    return this.transition(scheduleId, ['dispatching'], 'completed', 'completed');
  }

  async fail(scheduleId: string, note: string): Promise<Schedule> {
    return this.transition(scheduleId, ['dispatching'], 'failed', 'failed', nonEmpty(note, 'failure'));
  }

  async get(scheduleId: string): Promise<Schedule | null> {
    this.assertReady();
    const row = this.database.prepare('SELECT * FROM schedules WHERE schedule_id = ?')
      .get(nonEmpty(scheduleId, 'scheduleId')) as ScheduleRow | undefined;
    return row ? scheduleFromRow(row) : null;
  }

  async snapshot(): Promise<{ schedules: Schedule[]; lastEventSequence: number }> {
    this.assertReady();
    const rows = this.database.prepare('SELECT * FROM schedules ORDER BY run_at, created_at')
      .all() as ScheduleRow[];
    const cursor = this.database.prepare(
      'SELECT COALESCE(MAX(sequence), 0) AS sequence FROM schedule_events',
    ).get() as { sequence: number };
    return { schedules: rows.map(scheduleFromRow), lastEventSequence: cursor.sequence };
  }

  async events(after = 0, limit = 200): Promise<ScheduleEvent[]> {
    this.assertReady();
    if (!Number.isSafeInteger(after) || after < 0) throw new Error('Scheduler cursor is invalid.');
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) {
      throw new Error('Scheduler event limit must be from 1 to 1000.');
    }
    const rows = this.database.prepare(`
      SELECT sequence, schedule_id, event_type, status, note, occurred_at
      FROM schedule_events WHERE sequence > ? ORDER BY sequence LIMIT ?
    `).all(after, limit) as EventRow[];
    return rows.map((row) => ({
      sequence: row.sequence,
      scheduleId: row.schedule_id,
      eventType: row.event_type,
      status: row.status,
      ...(row.note === null ? {} : { note: row.note }),
      occurredAt: row.occurred_at,
    }));
  }

  private recoverInterrupted(): void {
    const rows = this.database.prepare("SELECT schedule_id FROM schedules WHERE status = 'dispatching'")
      .all() as Array<{ schedule_id: string }>;
    if (rows.length === 0) return;
    this.database.exec('BEGIN IMMEDIATE;');
    try {
      for (const row of rows) {
        const now = new Date().toISOString();
        const note = 'dispatch outcome unknown after restart';
        this.database.prepare(
          "UPDATE schedules SET status = 'failed', note = ?, updated_at = ? WHERE schedule_id = ?",
        ).run(note, now, row.schedule_id);
        this.insertEvent(row.schedule_id, 'recovered', 'failed', note, now);
      }
      this.database.exec('COMMIT;');
    } catch (error) {
      this.database.exec('ROLLBACK;');
      throw error;
    }
  }

  private async transition(
    scheduleId: string,
    allowed: readonly ScheduleStatus[],
    status: ScheduleStatus,
    eventType: ScheduleEvent['eventType'],
    note?: string,
  ): Promise<Schedule> {
    this.assertReady();
    const id = nonEmpty(scheduleId, 'scheduleId');
    const current = await this.get(id);
    if (!current) throw new Error(`Scheduler schedule "${id}" does not exist.`);
    if (!allowed.includes(current.status)) {
      throw new Error(`Scheduler schedule "${id}" is ${current.status}.`);
    }
    const now = new Date().toISOString();
    this.database.exec('BEGIN IMMEDIATE;');
    try {
      const result = this.database.prepare(`
        UPDATE schedules SET status = ?, note = ?, updated_at = ?
        WHERE schedule_id = ? AND status = ?
      `).run(status, note ?? null, now, id, current.status);
      if (result.changes !== 1) throw new Error(`Scheduler schedule "${id}" changed concurrently.`);
      this.insertEvent(id, eventType, status, note, now);
      this.database.exec('COMMIT;');
    } catch (error) {
      this.database.exec('ROLLBACK;');
      throw error;
    }
    return this.get(id) as Promise<Schedule>;
  }

  private insertEvent(
    scheduleId: string,
    eventType: ScheduleEvent['eventType'],
    status: ScheduleStatus,
    note: string | undefined,
    occurredAt: string,
  ): void {
    this.database.prepare(`
      INSERT INTO schedule_events(schedule_id, event_type, status, note, occurred_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(scheduleId, eventType, status, note ?? null, occurredAt);
  }

  private assertReady(): void {
    if (!this.initialized || this.closed) throw new Error('Scheduler service is not active.');
  }
}
