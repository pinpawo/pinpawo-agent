import assert from 'node:assert/strict';
import test from 'node:test';
import { createStudioStorage } from '../storage/studioStorage';
import { studioCoreMigrations } from '../storage/coreMigrations';
import { KyselyPetStore, type PetDatabase } from './store/kysely';
import { StudioPetCredentialVault } from './petCredentials';

async function setup(t: import('node:test').TestContext) {
  const storage = createStudioStorage({ kind: 'sqlite', path: ':memory:' });
  t.after(() => storage.close());
  const db = await storage.open<PetDatabase>('studio', studioCoreMigrations);
  const store = new KyselyPetStore(db);
  for (const petId of ['dev-a', 'dev-b']) {
    await store.createPet({ petId, definitionId: 'developer', name: petId, createdAt: 't' });
  }
  const vault = (key?: Uint8Array) => new StudioPetCredentialVault({ store: async () => store, key });
  return { db, vault };
}

const KEY = new Uint8Array(32).fill(7);

test('each Pet gets only its own credentials, stored encrypted', async (t) => {
  const { db, vault } = await setup(t);
  const credentials = vault(KEY);
  await credentials.set({ petId: 'dev-a', envName: 'GH_TOKEN', value: 'fake-a' });
  await credentials.set({ petId: 'dev-b', envName: 'GH_TOKEN', value: 'fake-b' });
  await credentials.set({ petId: 'dev-a', envName: 'GH_TOKEN', value: 'fake-a2' });

  assert.deepEqual(await credentials.source.environment('dev-a'), { GH_TOKEN: 'fake-a2' });
  assert.deepEqual(await credentials.source.environment('dev-b'), { GH_TOKEN: 'fake-b' });
  assert.deepEqual((await credentials.list('dev-a')).map(({ envName }) => envName), ['GH_TOKEN']);
  const stored = await db.selectFrom('studio_pet_credentials').select('encrypted_value').execute();
  assert.equal(stored.length, 2);
  assert.ok(stored.every(({ encrypted_value }) => !encrypted_value.includes('fake')));

  assert.deepEqual(await credentials.remove({ petId: 'dev-a', envName: 'GH_TOKEN' }), { removed: true });
  assert.deepEqual(await credentials.remove({ petId: 'dev-a', envName: 'GH_TOKEN' }), { removed: false });
  assert.deepEqual(await credentials.source.environment('dev-a'), {});
});

test('a ciphertext cannot be moved to another Pet, and a wrong key cannot read it', async (t) => {
  const { db, vault } = await setup(t);
  await vault(KEY).set({ petId: 'dev-a', envName: 'GH_TOKEN', value: 'fake-a' });
  await assert.rejects(vault(new Uint8Array(32).fill(8)).source.environment('dev-a'));
  await db.updateTable('studio_pet_credentials').set({ pet_id: 'dev-b' }).execute();
  await assert.rejects(vault(KEY).source.environment('dev-b'));
});

test('without a key credentials are locked, but Pets without credentials still run', async (t) => {
  const { vault } = await setup(t);
  await vault(KEY).set({ petId: 'dev-a', envName: 'GH_TOKEN', value: 'fake-a' });
  const locked = vault();
  assert.equal(locked.unlocked(), false);
  await assert.rejects(locked.set({ petId: 'dev-a', envName: 'X', value: 'v' }), (error: Error & { code?: string }) => error.code === 'locked');
  await assert.rejects(locked.source.environment('dev-a'), (error: Error & { code?: string }) => error.code === 'locked');
  assert.deepEqual(await locked.source.environment('dev-b'), {});
  assert.deepEqual((await locked.list('dev-a')).map(({ envName }) => envName), ['GH_TOKEN']);
  assert.throws(() => vault(new Uint8Array(31)), /32 bytes/);
});

test('names, values and Pets are validated', async (t) => {
  const { vault } = await setup(t);
  const credentials = vault(KEY);
  const code = (expected: string) => (error: Error & { code?: string }) => error.code === expected;
  await assert.rejects(credentials.set({ petId: 'dev-a', envName: '1BAD', value: 'v' }), code('invalid'));
  await assert.rejects(credentials.set({ petId: 'dev-a', envName: 'A=B', value: 'v' }), code('invalid'));
  await assert.rejects(credentials.set({ petId: 'dev-a', envName: 'OK', value: '' }), code('invalid'));
  await assert.rejects(credentials.set({ petId: 'dev-a', envName: 'OK', value: 'a\0b' }), code('invalid'));
  await assert.rejects(credentials.set({ petId: 'ghost', envName: 'OK', value: 'v' }), code('not_found'));
  await assert.rejects(credentials.list('ghost'), code('not_found'));
});
