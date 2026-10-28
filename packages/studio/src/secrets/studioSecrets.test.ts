import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createPglitePool } from '../../../../tests/support/pglitePool';
import { createStudioStorage, type StudioStorageConfig } from '../storage/studioStorage';
import { studioCoreMigrations } from '../storage/coreMigrations';
import { prepareStudio } from '../createStudio';
import { createStudioSecrets, StudioSecretError, type SecretDatabase } from './studioSecrets';

const key = Buffer.alloc(32, 0x6b); // fake test-only deployment key, never an env var
const backends: Array<[string, () => StudioStorageConfig]> = [
  ['sqlite', () => ({ kind: 'sqlite', path: ':memory:' })],
  ['postgres', () => ({ kind: 'postgres', pool: createPglitePool() })],
];
for (const [backend, config] of backends) {
  test(`${backend}: encrypted Secrets and atomic instance bindings support sharing, replacement and concurrent callers`, async () => {
    const storage = createStudioStorage(config());
    try {
      const db = await storage.open<SecretDatabase>('studio', studioCoreMigrations);
      await db.insertInto('studio_pets').values(['a', 'b', 'unbound'].map(pet_id => ({ pet_id, definition_id: 'shared', name: pet_id, created_at: new Date().toISOString() }))).execute();
      const { management, credentialSource } = createStudioSecrets(async () => db, key);
      const value = 'fake-business-token-unique';
      const meta = await management.put({ secretId: 'shared', name: 'Shared account', value });
      assert.deepEqual(Object.keys(meta).sort(), ['createdAt', 'name', 'secretId', 'updatedAt']);
      await management.put({ secretId: 'other', name: 'Other', value: 'fake-other' });
      await Promise.all(['a', 'b'].map(petId => management.bind({ petId, bindings: { SERVICE_TOKEN: 'shared' } })));
      assert.deepEqual(await credentialSource.readBindings('a'), { SERVICE_TOKEN: 'shared' });
      assert.deepEqual(await credentialSource.readBindings('b'), { SERVICE_TOKEN: 'shared' });
      assert.deepEqual(await credentialSource.readBindings('unbound'), {});
      assert.equal(await credentialSource.resolve('shared'), value);
      const rows = await db.selectFrom('studio_secrets').selectAll().execute();
      assert.equal(JSON.stringify(rows).includes(value), false);
      assert.equal(JSON.stringify(rows).includes(key.toString()), false);
      assert.equal(JSON.stringify(await management.list()).includes(value), false);
      assert.equal(JSON.stringify(management).includes(value), false);
      const encrypted = rows.find(row => row.secret_id === 'shared')!.encrypted_value;
      await management.put({ secretId: 'shared', name: 'Rotated', value: 'fake-replacement' });
      assert.equal(await credentialSource.resolve('shared'), 'fake-replacement');
      assert.equal((await management.list()).find(item => item.secretId === 'shared')!.createdAt, meta.createdAt);
      assert.notEqual((await db.selectFrom('studio_secrets').select('encrypted_value').where('secret_id', '=', 'shared').executeTakeFirstOrThrow()).encrypted_value, encrypted);
      // Failed replacement preserves all prior bindings; another instance is untouched.
      await assert.rejects(management.bind({ petId: 'a', bindings: { SERVICE_TOKEN: 'missing' } }), /Secret does not exist/);
      assert.deepEqual(await management.bindings('a'), { SERVICE_TOKEN: 'shared' });
      for (const bindings of [{ 'BAD=ENV': 'shared' }, { SERVICE_TOKEN: 1 }, []]) {
        await assert.rejects(management.bind({ petId: 'a', bindings }), /Invalid/);
      }
      await assert.rejects(management.bind({ petId: 'missing', bindings: {} }), /Pet does not exist/);
      await assert.rejects(credentialSource.readBindings('missing'), /Pet does not exist/);
      const operations: Promise<unknown>[] = [];
      for (let i = 0; i < 8; i++) {
        operations.push(management.bind({ petId: 'a', bindings: { SERVICE_TOKEN: i % 2 ? 'shared' : 'other' } }));
        operations.push(credentialSource.readBindings('a').then(bindings => {
          assert.deepEqual(Object.keys(bindings), ['SERVICE_TOKEN'], 'no intermediate empty replacement leaks to Runtime');
        }));
      }
      await Promise.all(operations);
      await management.bind({ petId: 'a', bindings: {} });
      assert.deepEqual(await credentialSource.readBindings('a'), {});
      assert.deepEqual(await management.bindings('b'), { SERVICE_TOKEN: 'shared' });
      assert.equal(await credentialSource.resolve('shared'), 'fake-replacement', 'unbinding one instance does not delete a shared Secret');
    } finally { await storage.close(); }
  });

  test(`${backend}: missing/wrong key, tampering and ciphertext row swaps fail without plaintext fallback or error leakage`, async () => {
    const storage = createStudioStorage(config());
    try {
      const db = await storage.open<SecretDatabase>('studio', studioCoreMigrations);
      const { management, credentialSource } = createStudioSecrets(async () => db, key);
      const value = 'fake-sensitive-value';
      await management.put({ secretId: 'a', name: 'A', value });
      await management.put({ secretId: 'b', name: 'B', value: 'fake-second-value' });
      const locked = createStudioSecrets(async () => db);
      assert.deepEqual(locked.management.status(), { unlocked: false });
      assert.equal((await locked.management.list()).length, 2, 'locked storage still exposes metadata only');
      await assert.rejects(locked.management.put({ secretId: 'c', name: 'C', value }), /locked/);
      await assert.rejects(locked.credentialSource.resolve('a'), /locked/);
      await assert.rejects(createStudioSecrets(async () => db, Buffer.alloc(32, 0x78)).credentialSource.resolve('a'), (error: Error) => {
        assert.ok(error instanceof StudioSecretError);
        assert.equal(error.message, 'Studio Secret operation failed.');
        assert.equal(error.cause, undefined);
        return true;
      });
      const encrypted = (await db.selectFrom('studio_secrets').select('encrypted_value').where('secret_id', '=', 'a').executeTakeFirstOrThrow()).encrypted_value;
      await db.updateTable('studio_secrets').set({ encrypted_value: encrypted }).where('secret_id', '=', 'b').execute();
      await assert.rejects(credentialSource.resolve('b'), /operation failed/);
      const envelope = JSON.parse(encrypted);
      envelope.tag = Buffer.alloc(16).toString('base64');
      await db.updateTable('studio_secrets').set({ encrypted_value: JSON.stringify(envelope) }).where('secret_id', '=', 'a').execute();
      await assert.rejects(credentialSource.resolve('a'), /operation failed/);
      await assert.rejects(credentialSource.resolve('missing'), /does not exist/);
      assert.throws(() => createStudioSecrets(async () => db, Buffer.alloc(31)), /32 bytes/);
      assert.equal(JSON.stringify(await locked.management.list()).includes(value), false);
    } finally { await storage.close(); }
  });
}

test('SQLite restart restores instance bindings and encrypted values with an independently supplied key', async t => {
  const root = await mkdtemp(join(tmpdir(), 'studio-secret-db-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, 'studio.sqlite');
  const first = createStudioStorage({ kind: 'sqlite', path });
  const db = await first.open<SecretDatabase>('studio', studioCoreMigrations);
  await db.insertInto('studio_pets').values({ pet_id: 'a', definition_id: 'shared', name: 'A', created_at: 'now' }).execute();
  const secrets = createStudioSecrets(async () => db, key);
  await secrets.management.put({ secretId: 'account', name: 'Account', value: 'fake-persisted-token' });
  await secrets.management.bind({ petId: 'a', bindings: { SERVICE_TOKEN: 'account' } });
  await first.close();
  assert.equal((await readFile(path)).includes(Buffer.from('fake-persisted-token')), false);
  assert.equal((await readFile(path)).includes(key), false);
  const second = createStudioStorage({ kind: 'sqlite', path });
  try {
    const reopened = await second.open<SecretDatabase>('studio', studioCoreMigrations);
    const restored = createStudioSecrets(async () => reopened, key);
    assert.deepEqual(await restored.credentialSource.readBindings('a'), { SERVICE_TOKEN: 'account' });
    assert.equal(await restored.credentialSource.resolve('account'), 'fake-persisted-token');
  } finally { await second.close(); }
});

test('Studio startup without a deployment key remains compatible and locked, with no plaintext write path', async () => {
  const prepared = prepareStudio({ studioId: 'locked', definitions: [], assemblePet: async () => { throw Error('unused'); } });
  try {
    await prepared.restorePets();
    assert.deepEqual(prepared.studio.secrets.status(), { unlocked: false });
    await assert.rejects(prepared.studio.secrets.put({ secretId: 'a', name: 'A', value: 'fake-token' }), /locked/);
    assert.equal('resolve' in prepared.studio.secrets, false);
    assert.equal('credentialSource' in prepared.studio, false);
  } finally { await prepared.studio.shutdown(); }
});
