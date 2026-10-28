import type { Kysely, Selectable } from 'kysely';
import type { PetRow, PetStore } from '../petStore';
import type { PetDatabase } from './schema';

function petRow(record: Selectable<PetDatabase['studio_pets']>): PetRow {
  return {
    petId: record.pet_id, definitionId: record.definition_id, name: record.name, createdAt: record.created_at,
    ...(record.archived_at === null ? {} : { archivedAt: record.archived_at }),
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
      pet_id: row.petId, definition_id: row.definitionId, name: row.name, created_at: row.createdAt, archived_at: row.archivedAt ?? null,
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

  async archivePet(petId: string, archivedAt: string): Promise<void> {
    await this.db.updateTable('studio_pets').set({ archived_at: archivedAt })
      .where('pet_id', '=', petId).where('archived_at', 'is', null).execute();
  }
}
