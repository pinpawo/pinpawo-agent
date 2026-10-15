import type { Kysely, Selectable } from 'kysely';
import type { ClientKeyRow, ClientRow, ClientStore } from '../clientStore';
import type { ClientDatabase } from './schema';

function clientRow(record: Selectable<ClientDatabase['studio_clients']>): ClientRow {
  return {
    clientId: record.client_id, label: record.label, createdAt: record.created_at,
    ...(record.revoked_at === null ? {} : { revokedAt: record.revoked_at }),
  };
}
function keyRow(record: Selectable<ClientDatabase['studio_client_keys']>): ClientKeyRow {
  return {
    keyHash: record.key_hash, clientId: record.client_id, createdAt: record.created_at,
    ...(record.revoked_at === null ? {} : { revokedAt: record.revoked_at }),
  };
}

/** The ClientStore on the Studio database (SQLite or Postgres). */
export class KyselyClientStore implements ClientStore {
  constructor(private readonly db: Kysely<ClientDatabase>) {}

  transaction<T>(work: (store: ClientStore) => Promise<T>): Promise<T> {
    if (this.db.isTransaction) return work(this);
    return this.db.transaction().execute(trx => work(new KyselyClientStore(trx)));
  }

  async createClient(row: ClientRow): Promise<boolean> {
    const inserted = await this.db.insertInto('studio_clients').values({
      client_id: row.clientId, label: row.label, created_at: row.createdAt, revoked_at: row.revokedAt ?? null,
    }).onConflict(conflict => conflict.column('client_id').doNothing()).executeTakeFirst();
    return Number(inserted.numInsertedOrUpdatedRows ?? 0) === 1;
  }

  async getClient(clientId: string): Promise<ClientRow | undefined> {
    const record = await this.db.selectFrom('studio_clients').selectAll().where('client_id', '=', clientId).executeTakeFirst();
    return record ? clientRow(record) : undefined;
  }

  async listClients(): Promise<ClientRow[]> {
    return (await this.db.selectFrom('studio_clients').selectAll().orderBy('created_at').orderBy('client_id').execute()).map(clientRow);
  }

  async revokeClient(clientId: string, revokedAt: string): Promise<void> {
    await this.db.updateTable('studio_clients').set({ revoked_at: revokedAt })
      .where('client_id', '=', clientId).where('revoked_at', 'is', null).execute();
  }

  async addKey(row: ClientKeyRow): Promise<void> {
    await this.db.insertInto('studio_client_keys').values({
      key_hash: row.keyHash, client_id: row.clientId, created_at: row.createdAt, revoked_at: row.revokedAt ?? null,
    }).execute();
  }

  async getKey(keyHash: string): Promise<ClientKeyRow | undefined> {
    const record = await this.db.selectFrom('studio_client_keys').selectAll().where('key_hash', '=', keyHash).executeTakeFirst();
    return record ? keyRow(record) : undefined;
  }
}
