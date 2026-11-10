import { sql, type Kysely } from 'kysely';
import type { StudioMigrations } from '../../../storage/studioStorage';

/** Studio Pet instances and their credentials; they share Studio core's migration history with client identities. */
export const petMigrations: StudioMigrations = {
  '0002_pets': {
    async up(db: Kysely<unknown>) {
      await db.schema.createTable('studio_pets')
        .addColumn('pet_id', 'text', column => column.primaryKey())
        .addColumn('definition_id', 'text', column => column.notNull())
        .addColumn('name', 'text', column => column.notNull())
        .addColumn('created_at', 'text', column => column.notNull())
        .execute();
    },
  },
  '0003_pet_credentials': {
    async up(db: Kysely<unknown>) {
      await db.schema.createTable('studio_pet_credentials')
        .addColumn('pet_id', 'text', column => column.notNull().references('studio_pets.pet_id').onDelete('cascade'))
        .addColumn('env_name', 'text', column => column.notNull())
        .addColumn('encrypted_value', 'text', column => column.notNull())
        .addColumn('updated_at', 'text', column => column.notNull())
        .addPrimaryKeyConstraint('studio_pet_credentials_pk', ['pet_id', 'env_name'])
        .execute();
    },
  },
  '0004_pet_channel': {
    async up(db: Kysely<unknown>) {
      // This slice has no data-ownership upgrade. Fail before changing the
      // schema/history so the previous version can still open the same data.
      const existing = await sql<{ pet_id: string }>`select pet_id from studio_pets limit 1`.execute(db);
      if (existing.rows.length) throw new Error(`Pet "${existing.rows[0]!.pet_id}" has no owner Channel. Existing data is unchanged. This version requires a new Studio database; keep using the previous version for this Studio until an explicit ownership upgrade is available.`);
      await db.schema.alterTable('studio_pets').addColumn('channel_id', 'text', column => column.notNull()).execute();
      await db.schema.alterTable('studio_pets').addColumn('closed_at', 'text').execute();
    },
  },
};
