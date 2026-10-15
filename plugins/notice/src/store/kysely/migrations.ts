import { sql, type Kysely } from 'kysely';
import type { StudioMigrations } from '@pinpawo/studio';

/** The Notice schema. Data from the earlier notice.sqlite is not carried over. */
export function noticeMigrations(): StudioMigrations {
  return {
    '0001_notices': {
      async up(db: Kysely<unknown>) {
        await db.schema.createTable('notices')
          .addColumn('notice_id', 'text', column => column.primaryKey())
          .addColumn('rule_id', 'text', column => column.notNull())
          .addColumn('level', 'text', column => column.notNull().check(sql`level in ('info', 'warning', 'error')`))
          .addColumn('title', 'text', column => column.notNull())
          .addColumn('source', 'text', column => column.notNull())
          .addColumn('event_type', 'text', column => column.notNull())
          .addColumn('payload', 'text')
          .addColumn('occurred_at', 'text', column => column.notNull())
          .execute();
        await db.schema.createIndex('notices_recent').on('notices').columns(['occurred_at', 'notice_id']).execute();
      },
    },
  };
}
