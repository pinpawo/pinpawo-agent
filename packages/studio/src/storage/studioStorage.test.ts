import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { sql, type Kysely } from 'kysely';
import { createPglitePool } from '../../../../tests/support/pglitePool';
import { createStudio } from '../createStudio';
import { resolveStudioStorage } from '../host/buildStudio';
import { studioLocalConfigSchema } from '../configSchema';
import { parseConfigDocument } from '@pinpawo/pet-agent';
import { createStudioStorage, type StudioMigrations, type StudioStorageConfig } from './studioStorage';

type NotesDb = { notes_items: { id: string; body: string } };

const notesV1: StudioMigrations = {
  '0001_items': { up: async (db: Kysely<unknown>) => {
    await db.schema.createTable('notes_items').addColumn('id', 'text', c => c.primaryKey()).execute();
  } },
};
const notesV2: StudioMigrations = {
  ...notesV1,
  '0002_body': { up: async (db: Kysely<unknown>) => {
    await db.schema.alterTable('notes_items').addColumn('body', 'text', c => c.notNull().defaultTo('')).execute();
  } },
};

const backends: Array<[string, () => StudioStorageConfig]> = [
  ['sqlite', () => ({ kind: 'sqlite', path: ':memory:' })],
  ['postgres', () => ({ kind: 'postgres', pool: createPglitePool() })],
];

for (const [name, config] of backends) {
  test(`${name}: each owner migrates once, with its own history`, async () => {
    const storage = createStudioStorage(config());
    try {
      assert.equal(storage.dialect, name);
      await storage.open('notes', notesV1);
      const db = await storage.open<NotesDb>('notes', notesV2);
      await db.insertInto('notes_items').values({ id: 'a', body: 'hello' }).execute();
      assert.deepEqual(await db.selectFrom('notes_items').selectAll().execute(), [{ id: 'a', body: 'hello' }]);

      const other: StudioMigrations = { '0001_items': { up: async (db: Kysely<unknown>) => {
        await db.schema.createTable('other_items').addColumn('id', 'text').execute();
      } } };
      await storage.open('other-plugin', other);
      const history = async (table: string) => (await sql<{ name: string }>`select name from ${sql.table(table)} order by name`.execute(db)).rows.map(row => row.name);
      assert.deepEqual(await history('notes_migrations'), ['0001_items', '0002_body']);
      assert.deepEqual(await history('other_plugin_migrations'), ['0001_items']);
    } finally { await storage.close(); }
  });

  test(`${name}: a failed migration names its owner and is retried on the next open`, async () => {
    const storage = createStudioStorage(config());
    try {
      let attempts = 0;
      const flaky: StudioMigrations = { '0001_items': { up: async (db: Kysely<unknown>) => {
        attempts++;
        if (attempts === 1) throw new Error('disk full');
        await db.schema.createTable('flaky_items').addColumn('id', 'text').execute();
      } } };
      await assert.rejects(storage.open('flaky', flaky), /Storage migrations for "flaky" failed: disk full/);
      await storage.open('flaky', flaky);
      assert.equal(attempts, 2);
    } finally { await storage.close(); }
  });
}

test('sqlite: a file database keeps data and history across opens and is private to its owner', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'studio-storage-'));
  const file = path.join(root, 'nested', 'studio.sqlite');
  try {
    const first = createStudioStorage({ kind: 'sqlite', path: file });
    const db = await first.open<NotesDb>('notes', notesV1);
    await db.insertInto('notes_items').values({ id: 'a' } as never).execute();
    await first.close();
    assert.equal(statSync(file).mode & 0o777, 0o600);

    const second = createStudioStorage({ kind: 'sqlite', path: file });
    const reopened = await second.open<NotesDb>('notes', notesV2);
    assert.deepEqual(await reopened.selectFrom('notes_items').selectAll().execute(), [{ id: 'a', body: '' }]);
    await second.close();
    await assert.rejects(second.open('notes', notesV2), /closed/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('Plugins open the Studio storage under their own name, and Studio closes it after they stop', async () => {
  const events: string[] = [];
  let db: Kysely<NotesDb> | undefined;
  const studio = await createStudio({
    studioId: 'storage',
    definitions: [],
    assemblePet: async () => { throw new Error('This Studio has no Pets.'); },
    plugins: [{
      name: 'notes', toolkits: [],
      start: async (context) => {
        assert.equal(context.storage.dialect, 'sqlite');
        db = await context.storage.open<NotesDb>(notesV2);
        await db.insertInto('notes_items').values({ id: 'a', body: 'kept' }).execute();
        const history = await sql<{ name: string }>`select name from notes_migrations`.execute(db);
        events.push(`migrated ${history.rows.length.toString()}`);
      },
      stop: async () => {
        events.push(`stopped with ${(await db!.selectFrom('notes_items').selectAll().execute()).length.toString()} rows`);
      },
    }],
  });
  await studio.shutdown();
  assert.deepEqual(events, ['migrated 2', 'stopped with 1 rows']);
  await assert.rejects(db!.selectFrom('notes_items').selectAll().execute());
});

test('studio.json storage: SQLite by default under the workdir, Postgres by url or by environment variable', () => {
  const parse = (storage: unknown) => parseConfigDocument({
    content: JSON.stringify({ studioId: 's', definitions: ['a'], ...(storage === undefined ? {} : { storage }) }),
    source: 'studio.json',
    schema: studioLocalConfigSchema,
  }).storage;

  assert.equal(parse(undefined), undefined);
  assert.deepEqual(resolveStudioStorage(parse(undefined), '/work'), { kind: 'sqlite', path: '/work/.pinpawo/studio/studio.sqlite' });
  assert.deepEqual(resolveStudioStorage(parse({ kind: 'sqlite', path: 'data/s.sqlite' }), '/work'), { kind: 'sqlite', path: '/work/data/s.sqlite' });
  assert.deepEqual(resolveStudioStorage(parse({ kind: 'postgres', url: 'postgres://db/studio' }), '/work'), { kind: 'postgres', url: 'postgres://db/studio' });
  assert.deepEqual(
    resolveStudioStorage(parse({ kind: 'postgres', urlEnv: 'STUDIO_DB' }), '/work', { STUDIO_DB: 'postgres://env/studio' }),
    { kind: 'postgres', url: 'postgres://env/studio' },
  );
  assert.throws(() => resolveStudioStorage(parse({ kind: 'postgres', urlEnv: 'STUDIO_DB' }), '/work', {}), /STUDIO_DB is not set/);

  assert.throws(() => parse({ kind: 'mysql' }), /"kind" must be "sqlite" or "postgres"/);
  assert.throws(() => parse({ kind: 'postgres' }), /exactly one of "url" and "urlEnv"/);
  assert.throws(() => parse({ kind: 'postgres', url: 'a', urlEnv: 'B' }), /exactly one of "url" and "urlEnv"/);
  assert.throws(() => parse({ kind: 'sqlite', url: 'postgres://db' }), /"url" is not a sqlite storage setting/);
});
