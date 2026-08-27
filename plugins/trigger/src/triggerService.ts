import { randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export type TriggerDeliveryStatus = 'dispatching' | 'accepted' | 'failed';

export type TriggerDelivery = {
  deliveryId: string;
  triggerId: string;
  idempotencyKey: string;
  status: TriggerDeliveryStatus;
  note?: string;
  occurredAt: string;
  updatedAt: string;
};

export type TriggerDeliveryEvent = {
  sequence: number;
  deliveryId: string;
  triggerId: string;
  eventType: 'received' | 'accepted' | 'failed' | 'recovered';
  status: TriggerDeliveryStatus;
  note?: string;
  occurredAt: string;
};

type DeliveryRow = {
  delivery_id: string;
  trigger_id: string;
  idempotency_key: string;
  status: TriggerDeliveryStatus;
  note: string | null;
  occurred_at: string;
  updated_at: string;
};

type EventRow = {
  sequence: number;
  delivery_id: string;
  trigger_id: string;
  event_type: TriggerDeliveryEvent['eventType'];
  status: TriggerDeliveryStatus;
  note: string | null;
  occurred_at: string;
};

function nonEmpty(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`Trigger ${label} must not be empty.`);
  return normalized;
}

function fromRow(row: DeliveryRow): TriggerDelivery {
  return {
    deliveryId: row.delivery_id,
    triggerId: row.trigger_id,
    idempotencyKey: row.idempotency_key,
    status: row.status,
    ...(row.note === null ? {} : { note: row.note }),
    occurredAt: row.occurred_at,
    updatedAt: row.updated_at,
  };
}

export class TriggerService {
  private readonly database: DatabaseSync;
  private initialized = false;
  private closed = false;

  constructor(databasePath = ':memory:') {
    if (databasePath !== ':memory:' && !path.isAbsolute(databasePath)) {
      throw new Error('Trigger databasePath must be absolute or :memory:.');
    }
    if (databasePath !== ':memory:') {
      const directory = path.dirname(databasePath);
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      chmodSync(directory, 0o700);
    }
    this.database = new DatabaseSync(databasePath, { timeout: 5_000 });
  }

  async init(): Promise<void> {
    if (this.closed) throw new Error('Trigger service is closed.');
    if (this.initialized) return;
    this.database.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = FULL;
      PRAGMA busy_timeout = 5000;
      PRAGMA trusted_schema = OFF;
      BEGIN IMMEDIATE;
      CREATE TABLE IF NOT EXISTS trigger_deliveries (
        delivery_id TEXT PRIMARY KEY,
        trigger_id TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('dispatching','accepted','failed')),
        note TEXT,
        occurred_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(trigger_id, idempotency_key)
      );
      CREATE TABLE IF NOT EXISTS trigger_delivery_events (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        delivery_id TEXT NOT NULL,
        trigger_id TEXT NOT NULL,
        event_type TEXT NOT NULL,
        status TEXT NOT NULL,
        note TEXT,
        occurred_at TEXT NOT NULL,
        FOREIGN KEY (delivery_id) REFERENCES trigger_deliveries(delivery_id) ON DELETE RESTRICT
      );
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

  async claim(triggerId: string, idempotencyKey: string): Promise<{
    delivery: TriggerDelivery;
    duplicate: boolean;
  }> {
    this.assertReady();
    const normalizedTriggerId = nonEmpty(triggerId, 'triggerId');
    const normalizedKey = nonEmpty(idempotencyKey, 'idempotencyKey');
    const existing = this.find(normalizedTriggerId, normalizedKey);
    if (existing) return { delivery: existing, duplicate: true };
    const deliveryId = randomUUID();
    const now = new Date().toISOString();
    this.database.exec('BEGIN IMMEDIATE;');
    try {
      this.database.prepare(`
        INSERT INTO trigger_deliveries(
          delivery_id, trigger_id, idempotency_key, status, occurred_at, updated_at
        ) VALUES (?, ?, ?, 'dispatching', ?, ?)
      `).run(deliveryId, normalizedTriggerId, normalizedKey, now, now);
      this.insertEvent(deliveryId, normalizedTriggerId, 'received', 'dispatching', undefined, now);
      this.database.exec('COMMIT;');
    } catch (error) {
      this.database.exec('ROLLBACK;');
      const raced = this.find(normalizedTriggerId, normalizedKey);
      if (raced) return { delivery: raced, duplicate: true };
      throw error;
    }
    return { delivery: this.get(deliveryId)!, duplicate: false };
  }

  async accept(deliveryId: string): Promise<TriggerDelivery> {
    return this.transition(deliveryId, 'accepted', 'accepted');
  }

  async fail(deliveryId: string, note: string): Promise<TriggerDelivery> {
    return this.transition(deliveryId, 'failed', 'failed', nonEmpty(note, 'failure'));
  }

  async snapshot(): Promise<{ deliveries: TriggerDelivery[]; lastEventSequence: number }> {
    this.assertReady();
    const rows = this.database.prepare(
      'SELECT * FROM trigger_deliveries ORDER BY occurred_at DESC LIMIT 500',
    ).all() as DeliveryRow[];
    const cursor = this.database.prepare(
      'SELECT COALESCE(MAX(sequence), 0) AS sequence FROM trigger_delivery_events',
    ).get() as { sequence: number };
    return { deliveries: rows.map(fromRow), lastEventSequence: cursor.sequence };
  }

  async events(after = 0, limit = 200): Promise<TriggerDeliveryEvent[]> {
    this.assertReady();
    if (!Number.isSafeInteger(after) || after < 0) throw new Error('Trigger cursor is invalid.');
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) {
      throw new Error('Trigger event limit must be from 1 to 1000.');
    }
    const rows = this.database.prepare(`
      SELECT sequence, delivery_id, trigger_id, event_type, status, note, occurred_at
      FROM trigger_delivery_events WHERE sequence > ? ORDER BY sequence LIMIT ?
    `).all(after, limit) as EventRow[];
    return rows.map((row) => ({
      sequence: row.sequence,
      deliveryId: row.delivery_id,
      triggerId: row.trigger_id,
      eventType: row.event_type,
      status: row.status,
      ...(row.note === null ? {} : { note: row.note }),
      occurredAt: row.occurred_at,
    }));
  }

  private get(deliveryId: string): TriggerDelivery | null {
    const row = this.database.prepare('SELECT * FROM trigger_deliveries WHERE delivery_id = ?')
      .get(deliveryId) as DeliveryRow | undefined;
    return row ? fromRow(row) : null;
  }

  private find(triggerId: string, idempotencyKey: string): TriggerDelivery | null {
    const row = this.database.prepare(`
      SELECT * FROM trigger_deliveries WHERE trigger_id = ? AND idempotency_key = ?
    `).get(triggerId, idempotencyKey) as DeliveryRow | undefined;
    return row ? fromRow(row) : null;
  }

  private async transition(
    deliveryId: string,
    status: 'accepted' | 'failed',
    eventType: 'accepted' | 'failed',
    note?: string,
  ): Promise<TriggerDelivery> {
    this.assertReady();
    const now = new Date().toISOString();
    const normalizedId = nonEmpty(deliveryId, 'deliveryId');
    this.database.exec('BEGIN IMMEDIATE;');
    try {
      const current = this.get(normalizedId);
      if (!current || current.status !== 'dispatching') {
        throw new Error(`Trigger delivery "${normalizedId}" is not dispatching.`);
      }
      this.database.prepare(`
        UPDATE trigger_deliveries SET status = ?, note = ?, updated_at = ?
        WHERE delivery_id = ?
      `).run(status, note ?? null, now, normalizedId);
      this.insertEvent(normalizedId, current.triggerId, eventType, status, note, now);
      this.database.exec('COMMIT;');
    } catch (error) {
      this.database.exec('ROLLBACK;');
      throw error;
    }
    return this.get(normalizedId)!;
  }

  private recoverInterrupted(): void {
    const rows = this.database.prepare(`
      SELECT delivery_id, trigger_id FROM trigger_deliveries WHERE status = 'dispatching'
    `).all() as Array<{ delivery_id: string; trigger_id: string }>;
    if (rows.length === 0) return;
    this.database.exec('BEGIN IMMEDIATE;');
    try {
      for (const row of rows) {
        const now = new Date().toISOString();
        const note = 'dispatch outcome unknown after restart';
        this.database.prepare(`
          UPDATE trigger_deliveries SET status = 'failed', note = ?, updated_at = ?
          WHERE delivery_id = ?
        `).run(note, now, row.delivery_id);
        this.insertEvent(row.delivery_id, row.trigger_id, 'recovered', 'failed', note, now);
      }
      this.database.exec('COMMIT;');
    } catch (error) {
      this.database.exec('ROLLBACK;');
      throw error;
    }
  }

  private insertEvent(
    deliveryId: string,
    triggerId: string,
    eventType: TriggerDeliveryEvent['eventType'],
    status: TriggerDeliveryStatus,
    note: string | undefined,
    occurredAt: string,
  ): void {
    this.database.prepare(`
      INSERT INTO trigger_delivery_events(
        delivery_id, trigger_id, event_type, status, note, occurred_at
      ) VALUES (?, ?, ?, ?, ?, ?)
    `).run(deliveryId, triggerId, eventType, status, note ?? null, occurredAt);
  }

  private assertReady(): void {
    if (!this.initialized || this.closed) throw new Error('Trigger service is not active.');
  }
}
