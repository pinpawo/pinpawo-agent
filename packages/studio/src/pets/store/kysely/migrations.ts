import type { Kysely } from 'kysely';
import type { StudioMigrations } from '../../../storage/studioStorage';

/** Studio Pet instances; they share Studio core's migration history with client identities. */
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
};
