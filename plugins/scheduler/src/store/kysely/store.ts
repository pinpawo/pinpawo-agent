import type { Kysely, Selectable } from 'kysely';
import type { Schedule, ScheduleEvent, ScheduleStatus, ScheduleStore, ScheduleTransition } from '../scheduleStore';
import type { SchedulerDatabase } from './schema';

function scheduleRow(record: Selectable<SchedulerDatabase['schedules']>): Schedule {
  return {
    scheduleId: record.schedule_id,
    petId: record.pet_id,
    ...(record.channel_id === null ? {} : { channelId: record.channel_id }),
    request: record.request,
    runAt: record.run_at,
    status: record.status,
    ...(record.note === null ? {} : { note: record.note }),
    ...(record.invocation_id === null ? {} : {
      receipt: { invocationId: record.invocation_id, ...(record.session_id === null ? {} : { sessionId: record.session_id }) },
    }),
    createdAt: record.created_at,
    updatedAt: record.updated_at,
  };
}
function eventRow(record: Selectable<SchedulerDatabase['schedule_events']>): ScheduleEvent {
  return {
    sequence: Number(record.sequence),
    scheduleId: record.schedule_id,
    eventType: record.event_type,
    status: record.status,
    ...(record.note === null ? {} : { note: record.note }),
    occurredAt: record.occurred_at,
  };
}

/** The ScheduleStore on the Studio database (SQLite or Postgres). */
export class KyselyScheduleStore implements ScheduleStore {
  constructor(private readonly db: Kysely<SchedulerDatabase>) {}

  transaction<T>(work: (store: ScheduleStore) => Promise<T>): Promise<T> {
    if (this.db.isTransaction) return work(this);
    return this.db.transaction().execute(trx => work(new KyselyScheduleStore(trx)));
  }

  async insertSchedule(schedule: Schedule): Promise<void> {
    await this.db.insertInto('schedules').values({
      schedule_id: schedule.scheduleId,
      pet_id: schedule.petId,
      channel_id: schedule.channelId ?? null,
      request: schedule.request,
      run_at: schedule.runAt,
      status: schedule.status,
      note: schedule.note ?? null,
      invocation_id: schedule.receipt?.invocationId ?? null,
      session_id: schedule.receipt?.sessionId ?? null,
      created_at: schedule.createdAt,
      updated_at: schedule.updatedAt,
    }).execute();
  }

  async getSchedule(scheduleId: string): Promise<Schedule | undefined> {
    const record = await this.db.selectFrom('schedules').selectAll().where('schedule_id', '=', scheduleId).executeTakeFirst();
    return record ? scheduleRow(record) : undefined;
  }

  async listSchedules(filter: { status?: ScheduleStatus; dueBy?: string; limit?: number } = {}): Promise<Schedule[]> {
    let query = this.db.selectFrom('schedules').selectAll();
    if (filter.status !== undefined) query = query.where('status', '=', filter.status);
    if (filter.dueBy !== undefined) query = query.where('run_at', '<=', filter.dueBy);
    query = query.orderBy('run_at').orderBy('created_at').orderBy('schedule_id');
    if (filter.limit !== undefined) query = query.limit(filter.limit);
    return (await query.execute()).map(scheduleRow);
  }

  async transition(scheduleId: string, change: ScheduleTransition): Promise<boolean> {
    const result = await this.db.updateTable('schedules').set({
      status: change.status,
      note: change.note ?? null,
      updated_at: change.updatedAt,
      ...(change.receipt ? { invocation_id: change.receipt.invocationId, session_id: change.receipt.sessionId ?? null } : {}),
    }).where('schedule_id', '=', scheduleId).where('status', '=', change.from).executeTakeFirst();
    return Number(result.numUpdatedRows) === 1;
  }

  async appendEvent(event: Omit<ScheduleEvent, 'sequence'>): Promise<ScheduleEvent> {
    const { sequence } = await this.db.insertInto('schedule_events').values({
      schedule_id: event.scheduleId,
      event_type: event.eventType,
      status: event.status,
      note: event.note ?? null,
      occurred_at: event.occurredAt,
    }).returning('sequence').executeTakeFirstOrThrow();
    return { ...event, sequence: Number(sequence) };
  }

  async readEvents(after: number, limit: number): Promise<ScheduleEvent[]> {
    return (await this.db.selectFrom('schedule_events').selectAll()
      .where('sequence', '>', after).orderBy('sequence').limit(limit).execute()).map(eventRow);
  }

  async lastEventSequence(): Promise<number> {
    const { sequence } = await this.db.selectFrom('schedule_events')
      .select(eb => eb.fn.max('sequence').as('sequence')).executeTakeFirstOrThrow();
    return Number(sequence ?? 0);
  }
}
