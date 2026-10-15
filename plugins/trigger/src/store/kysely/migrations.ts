import { sql, type Kysely } from 'kysely';
import type { StudioMigrations, StudioStorageDialect } from '@pinpawo/studio';

/** The Trigger schema. Data from the earlier trigger.sqlite is not carried over. */
export function triggerMigrations(dialect: StudioStorageDialect): StudioMigrations {
  const counter = dialect === 'postgres' ? 'serial' : 'integer';
  return {
    '0001_trigger_deliveries': {
      async up(db: Kysely<unknown>) {
        await db.schema.createTable('trigger_deliveries')
          .addColumn('delivery_id', 'text', column => column.primaryKey())
          .addColumn('trigger_id', 'text', column => column.notNull())
          .addColumn('idempotency_key', 'text', column => column.notNull())
          .addColumn('target_pet_id', 'text')
          .addColumn('request', 'text')
          .addColumn('status', 'text', column => column.notNull().check(sql`status in ('dispatching', 'accepted', 'failed')`))
          .addColumn('note', 'text')
          .addColumn('invocation_id', 'text')
          .addColumn('session_id', 'text')
          .addColumn('occurred_at', 'text', column => column.notNull())
          .addColumn('updated_at', 'text', column => column.notNull())
          .addUniqueConstraint('trigger_deliveries_idempotency', ['trigger_id', 'idempotency_key'])
          .execute();
        await db.schema.createIndex('trigger_deliveries_status').on('trigger_deliveries').columns(['status', 'occurred_at']).execute();
        await db.schema.createTable('trigger_delivery_events')
          .addColumn('sequence', counter, column => (dialect === 'postgres' ? column.primaryKey() : column.primaryKey().autoIncrement()))
          .addColumn('delivery_id', 'text', column => column.notNull().references('trigger_deliveries.delivery_id'))
          .addColumn('trigger_id', 'text', column => column.notNull())
          .addColumn('event_type', 'text', column => column.notNull())
          .addColumn('status', 'text', column => column.notNull())
          .addColumn('note', 'text')
          .addColumn('occurred_at', 'text', column => column.notNull())
          .execute();
      },
    },
  };
}
