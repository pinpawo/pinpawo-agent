import type { Kysely } from 'kysely';
import type { StudioMigrations } from '../../../storage/studioStorage';

/** Studio client identities. */
export const clientMigrations: StudioMigrations = {
  '0001_clients': {
    async up(db: Kysely<unknown>) {
      await db.schema.createTable('studio_clients')
        .addColumn('client_id', 'text', column => column.primaryKey())
        .addColumn('label', 'text', column => column.notNull())
        .addColumn('created_at', 'text', column => column.notNull())
        .addColumn('revoked_at', 'text')
        .execute();
      await db.schema.createTable('studio_client_keys')
        .addColumn('key_hash', 'text', column => column.primaryKey())
        .addColumn('client_id', 'text', column => column.notNull().references('studio_clients.client_id'))
        .addColumn('created_at', 'text', column => column.notNull())
        .addColumn('revoked_at', 'text')
        .execute();
      await db.schema.createIndex('studio_client_keys_by_client').on('studio_client_keys').column('client_id').execute();
    },
  },
};
