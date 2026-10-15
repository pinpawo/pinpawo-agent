import type { Kysely, Selectable } from 'kysely';
import type {
  TriggerDelivery, TriggerDeliveryEvent, TriggerDeliveryStatus, TriggerDeliveryTransition, TriggerStore,
} from '../triggerStore';
import type { TriggerDatabase } from './schema';

function deliveryRow(record: Selectable<TriggerDatabase['trigger_deliveries']>): TriggerDelivery {
  return {
    deliveryId: record.delivery_id,
    triggerId: record.trigger_id,
    idempotencyKey: record.idempotency_key,
    ...(record.target_pet_id === null ? {} : { targetPetId: record.target_pet_id }),
    ...(record.request === null ? {} : { request: record.request }),
    status: record.status,
    ...(record.note === null ? {} : { note: record.note }),
    ...(record.invocation_id === null ? {} : {
      receipt: { invocationId: record.invocation_id, ...(record.session_id === null ? {} : { sessionId: record.session_id }) },
    }),
    occurredAt: record.occurred_at,
    updatedAt: record.updated_at,
  };
}

function eventRow(record: Selectable<TriggerDatabase['trigger_delivery_events']>): TriggerDeliveryEvent {
  return {
    sequence: Number(record.sequence),
    deliveryId: record.delivery_id,
    triggerId: record.trigger_id,
    eventType: record.event_type,
    status: record.status,
    ...(record.note === null ? {} : { note: record.note }),
    occurredAt: record.occurred_at,
  };
}

/** The TriggerStore on the Studio database (SQLite or Postgres). */
export class KyselyTriggerStore implements TriggerStore {
  constructor(private readonly db: Kysely<TriggerDatabase>) {}

  transaction<T>(work: (store: TriggerStore) => Promise<T>): Promise<T> {
    if (this.db.isTransaction) return work(this);
    return this.db.transaction().execute(trx => work(new KyselyTriggerStore(trx)));
  }

  async insertDelivery(delivery: TriggerDelivery): Promise<boolean> {
    const inserted = await this.db.insertInto('trigger_deliveries').values({
      delivery_id: delivery.deliveryId,
      trigger_id: delivery.triggerId,
      idempotency_key: delivery.idempotencyKey,
      target_pet_id: delivery.targetPetId ?? null,
      request: delivery.request ?? null,
      status: delivery.status,
      note: delivery.note ?? null,
      invocation_id: delivery.receipt?.invocationId ?? null,
      session_id: delivery.receipt?.sessionId ?? null,
      occurred_at: delivery.occurredAt,
      updated_at: delivery.updatedAt,
    }).onConflict(conflict => conflict.columns(['trigger_id', 'idempotency_key']).doNothing())
      .returning('delivery_id').executeTakeFirst();
    return inserted !== undefined;
  }

  async getDelivery(deliveryId: string): Promise<TriggerDelivery | undefined> {
    const record = await this.db.selectFrom('trigger_deliveries').selectAll()
      .where('delivery_id', '=', deliveryId).executeTakeFirst();
    return record ? deliveryRow(record) : undefined;
  }

  async findDelivery(triggerId: string, idempotencyKey: string): Promise<TriggerDelivery | undefined> {
    const record = await this.db.selectFrom('trigger_deliveries').selectAll()
      .where('trigger_id', '=', triggerId).where('idempotency_key', '=', idempotencyKey).executeTakeFirst();
    return record ? deliveryRow(record) : undefined;
  }

  async listDeliveries(filter: { status?: TriggerDeliveryStatus; limit?: number } = {}): Promise<TriggerDelivery[]> {
    let query = this.db.selectFrom('trigger_deliveries').selectAll();
    if (filter.status !== undefined) query = query.where('status', '=', filter.status);
    query = query.orderBy('occurred_at', 'desc').orderBy('delivery_id');
    if (filter.limit !== undefined) query = query.limit(filter.limit);
    return (await query.execute()).map(deliveryRow);
  }

  async transition(deliveryId: string, change: TriggerDeliveryTransition): Promise<boolean> {
    const result = await this.db.updateTable('trigger_deliveries').set({
      status: change.status,
      note: change.note ?? null,
      updated_at: change.updatedAt,
      ...(change.receipt ? { invocation_id: change.receipt.invocationId, session_id: change.receipt.sessionId ?? null } : {}),
    }).where('delivery_id', '=', deliveryId).where('status', '=', change.from).executeTakeFirst();
    return Number(result.numUpdatedRows) === 1;
  }

  async appendEvent(event: Omit<TriggerDeliveryEvent, 'sequence'>): Promise<TriggerDeliveryEvent> {
    const { sequence } = await this.db.insertInto('trigger_delivery_events').values({
      delivery_id: event.deliveryId,
      trigger_id: event.triggerId,
      event_type: event.eventType,
      status: event.status,
      note: event.note ?? null,
      occurred_at: event.occurredAt,
    }).returning('sequence').executeTakeFirstOrThrow();
    return { ...event, sequence: Number(sequence) };
  }

  async readEvents(after: number, limit: number): Promise<TriggerDeliveryEvent[]> {
    return (await this.db.selectFrom('trigger_delivery_events').selectAll()
      .where('sequence', '>', after).orderBy('sequence').limit(limit).execute()).map(eventRow);
  }

  async lastEventSequence(): Promise<number> {
    const { sequence } = await this.db.selectFrom('trigger_delivery_events')
      .select(eb => eb.fn.max('sequence').as('sequence')).executeTakeFirstOrThrow();
    return Number(sequence ?? 0);
  }
}
