import { sql, type Kysely } from 'kysely';
import type { StudioMigrations, StudioStorageDialect } from '@pinpawo/studio-core';

/** The Scheduler schema. Data from the earlier scheduler.sqlite is not carried over. */
export function schedulerMigrations(dialect: StudioStorageDialect): StudioMigrations {
  const counter = dialect === 'postgres' ? 'serial' : 'integer';
  const statusCheck = sql`status in ('scheduled', 'dispatching', 'dispatched', 'failed', 'cancelled')`;
  return {
    '0001_schedules': {
      async up(db: Kysely<unknown>) {
        await db.schema.createTable('schedules')
          .addColumn('schedule_id', 'text', column => column.primaryKey())
          .addColumn('pet_id', 'text', column => column.notNull())
          .addColumn('channel_id', 'text')
          .addColumn('request', 'text', column => column.notNull())
          .addColumn('run_at', 'text', column => column.notNull())
          .addColumn('status', 'text', column => column.notNull().check(statusCheck))
          .addColumn('note', 'text')
          .addColumn('invocation_id', 'text')
          .addColumn('session_id', 'text')
          .addColumn('created_at', 'text', column => column.notNull())
          .addColumn('updated_at', 'text', column => column.notNull())
          .execute();
        await db.schema.createIndex('schedules_due').on('schedules').columns(['status', 'run_at']).execute();
        await db.schema.createTable('schedule_events')
          .addColumn('sequence', counter, column => (dialect === 'postgres' ? column.primaryKey() : column.primaryKey().autoIncrement()))
          .addColumn('schedule_id', 'text', column => column.notNull().references('schedules.schedule_id'))
          .addColumn('event_type', 'text', column => column.notNull())
          .addColumn('status', 'text', column => column.notNull())
          .addColumn('note', 'text')
          .addColumn('occurred_at', 'text', column => column.notNull())
          .execute();
      },
    },
  };
}
