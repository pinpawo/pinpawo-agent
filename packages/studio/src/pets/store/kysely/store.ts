import type { Kysely, Selectable } from 'kysely';
import type { PetCredentialRow, PetRow, PetStore } from '../petStore';
import type { PetDatabase } from './schema';

function petRow(record: Selectable<PetDatabase['studio_pets']>): PetRow {
  return {
    petId: record.pet_id, definitionId: record.definition_id, name: record.name, createdAt: record.created_at,
  };
}

/** The PetStore on the Studio database (SQLite or Postgres). */
export class KyselyPetStore implements PetStore {
  constructor(private readonly db: Kysely<PetDatabase>) {}

  transaction<T>(work: (store: PetStore) => Promise<T>): Promise<T> {
    if (this.db.isTransaction) return work(this);
    return this.db.transaction().execute(trx => work(new KyselyPetStore(trx)));
  }

  async createPet(row: PetRow): Promise<boolean> {
    const inserted = await this.db.insertInto('studio_pets').values({
      pet_id: row.petId, definition_id: row.definitionId, name: row.name, created_at: row.createdAt,
    }).onConflict(conflict => conflict.column('pet_id').doNothing()).executeTakeFirst();
    return Number(inserted.numInsertedOrUpdatedRows ?? 0) === 1;
  }

  async deletePet(petId: string): Promise<void> {
    await this.db.deleteFrom('studio_pets').where('pet_id', '=', petId).execute();
  }

  async getPet(petId: string): Promise<PetRow | undefined> {
    const record = await this.db.selectFrom('studio_pets').selectAll().where('pet_id', '=', petId).executeTakeFirst();
    return record ? petRow(record) : undefined;
  }

  async listPets(): Promise<PetRow[]> {
    return (await this.db.selectFrom('studio_pets').selectAll().orderBy('created_at').orderBy('pet_id').execute()).map(petRow);
  }

  async renamePet(petId: string, name: string): Promise<void> {
    await this.db.updateTable('studio_pets').set({ name }).where('pet_id', '=', petId).execute();
  }

  async listCredentials(petId: string): Promise<PetCredentialRow[]> {
    const records = await this.db.selectFrom('studio_pet_credentials').selectAll()
      .where('pet_id', '=', petId).orderBy('env_name').execute();
    return records.map(record => ({
      petId: record.pet_id, envName: record.env_name, encryptedValue: record.encrypted_value, updatedAt: record.updated_at,
    }));
  }

  async setCredential(row: PetCredentialRow): Promise<void> {
    await this.db.insertInto('studio_pet_credentials').values({
      pet_id: row.petId, env_name: row.envName, encrypted_value: row.encryptedValue, updated_at: row.updatedAt,
    }).onConflict(conflict => conflict.columns(['pet_id', 'env_name']).doUpdateSet({
      encrypted_value: row.encryptedValue, updated_at: row.updatedAt,
    })).execute();
  }

  async deleteCredential(petId: string, envName: string): Promise<boolean> {
    const deleted = await this.db.deleteFrom('studio_pet_credentials')
      .where('pet_id', '=', petId).where('env_name', '=', envName).executeTakeFirst();
    return Number(deleted.numDeletedRows) > 0;
  }
}
