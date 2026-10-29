import type { Kysely } from 'kysely';
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
};
