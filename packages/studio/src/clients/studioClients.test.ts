import assert from 'node:assert/strict';
import test from 'node:test';
import { sql } from 'kysely';
import { createPglitePool } from '../../../../tests/support/pglitePool';
import { createStudioStorage, type StudioStorageConfig } from '../storage/studioStorage';
import { KyselyClientStore, clientMigrations, type ClientDatabase } from './store/kysely';
import { StudioClientError, StudioClients } from './studioClients';

const backends: Array<[string, () => StudioStorageConfig]> = [
  ['sqlite', () => ({ kind: 'sqlite', path: ':memory:' })],
  ['postgres', () => ({ kind: 'postgres', pool: createPglitePool() })],
];

for (const [backend, config] of backends) {
  test(`${backend}: a client connects with any of its keys until it is revoked, and only key hashes are stored`, async () => {
    const storage = createStudioStorage(config());
    try {
      const db = await storage.open<ClientDatabase>('studio', clientMigrations);
      const clients = new StudioClients(async () => new KyselyClientStore(db));
      const { client, key } = await clients.create({ clientId: ' alice ', label: 'Alice' });
      assert.deepEqual([client.clientId, client.label], ['alice', 'Alice']);
      assert.match(key, /^pps_[A-Za-z0-9_-]{43}$/);
      assert.equal((await clients.authenticate(key))?.clientId, 'alice');
      assert.equal(await clients.authenticate(`${key}x`), undefined);
      assert.equal(await clients.authenticate('not-a-key'), undefined);
      const stored = await sql<{ key_hash: string }>`select key_hash from studio_client_keys`.execute(db);
      assert.deepEqual(stored.rows.map(row => row.key_hash.length), [64]);
      assert.ok(!stored.rows.some(row => row.key_hash.includes(key)));

      await assert.rejects(clients.create({ clientId: 'alice', label: 'Again' }), (error: unknown) => error instanceof StudioClientError && error.code === 'exists');
      for (const input of [{ clientId: 'a b', label: 'A' }, { clientId: '-a', label: 'A' }, { clientId: 'a', label: ' ' }, { clientId: 'a'.repeat(65), label: 'A' }]) {
        await assert.rejects(clients.create(input), (error: unknown) => error instanceof StudioClientError && error.code === 'invalid');
      }

      const second = await clients.addKey('alice');
      assert.equal((await clients.authenticate(second.key))?.clientId, 'alice');
      await assert.rejects(clients.addKey('bob'), (error: unknown) => error instanceof StudioClientError && error.code === 'not_found');

      // ensure() registers once and never changes an existing client.
      assert.equal((await clients.ensure({ clientId: 'local', label: 'Local' })).label, 'Local');
      assert.equal((await clients.ensure({ clientId: 'alice', label: 'Other' })).label, 'Alice');
      assert.deepEqual((await clients.list()).map(item => item.clientId).sort(), ['alice', 'local']);

      const revoked = await clients.revoke('alice');
      assert.ok(revoked.revokedAt);
      assert.equal(await clients.authenticate(key), undefined);
      assert.equal(await clients.authenticate(second.key), undefined);
      assert.equal((await clients.revoke('alice')).revokedAt, revoked.revokedAt);
      await assert.rejects(clients.addKey('alice'), (error: unknown) => error instanceof StudioClientError && error.code === 'not_found');
      await assert.rejects(clients.revoke('bob'), (error: unknown) => error instanceof StudioClientError && error.code === 'not_found');
    } finally { await storage.close(); }
  });
}
