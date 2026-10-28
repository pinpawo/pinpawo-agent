import type { StudioMigrations } from '../storage/studioStorage';

export const secretMigrations: StudioMigrations = {
  '0003_secrets': {
    async up(db) {
      await db.schema.createTable('studio_secrets')
        .addColumn('secret_id', 'text', c => c.primaryKey())
        .addColumn('name', 'text', c => c.notNull())
        .addColumn('encrypted_value', 'text', c => c.notNull())
        .addColumn('created_at', 'text', c => c.notNull())
        .addColumn('updated_at', 'text', c => c.notNull()).execute();
      await db.schema.createTable('studio_pet_credentials')
        .addColumn('pet_id', 'text', c => c.notNull().references('studio_pets.pet_id').onDelete('cascade'))
        .addColumn('env_name', 'text', c => c.notNull())
        .addColumn('secret_id', 'text', c => c.notNull().references('studio_secrets.secret_id'))
        .addPrimaryKeyConstraint('studio_pet_credentials_pk', ['pet_id', 'env_name']).execute();
    },
  },
};
