import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { createStudioStorage } from '../storage/studioStorage';
import { studioCoreMigrations } from '../storage/coreMigrations';
import { createStudioSecrets, type SecretDatabase } from './studioSecrets';

type Change = { petId: string; envName: string; secretId: string | null; expectedSecretId: string | null };
type Result = { ok: boolean; code?: string };

async function independentProcess(t: TestContext, path: string) {
  // Separate Node process, Kysely connection and service instance: there is no
  // shared JS mutex or transaction queue between these two management replicas.
  const script = `
    import { createStudioStorage } from ${JSON.stringify(new URL('../storage/studioStorage.ts', import.meta.url).href)};
    import { studioCoreMigrations } from ${JSON.stringify(new URL('../storage/coreMigrations.ts', import.meta.url).href)};
    import { createStudioSecrets } from ${JSON.stringify(new URL('./studioSecrets.ts', import.meta.url).href)};
    const storage = createStudioStorage({kind: 'sqlite', path: ${JSON.stringify(path)}});
    const db = await storage.open('studio', studioCoreMigrations);
    const management = createStudioSecrets(async () => db, Buffer.alloc(32, 107)).management;
    process.on('message', async message => {
      if (message === 'close') { await storage.close(); process.disconnect(); return; }
      try { await management.compareAndSetBinding(message); process.send({ok: true}); }
      catch (error) { process.send({ok: false, code: error.code}); }
    });
    process.send('ready');
  `;
  const child = spawn(process.execPath, ['--import', 'tsx/esm', '--input-type=module', '--eval', script], {
    cwd: process.cwd(), stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  });
  let errors = '';
  child.stderr!.on('data', chunk => { errors += chunk.toString(); });
  const exited = new Promise<void>(resolve => child.once('exit', () => resolve()));
  t.after(async () => {
    if (child.exitCode === null) child.kill();
    await exited;
  });
  const message = () => new Promise<unknown>((resolve, reject) => {
    const failed = () => { cleanup(); reject(new Error(`CAS worker exited: ${errors}`)); };
    const received = (value: unknown) => { cleanup(); resolve(value); };
    const cleanup = () => { child.off('exit', failed); child.off('message', received); };
    child.once('exit', failed); child.once('message', received);
  });
  assert.equal(await message(), 'ready');
  return {
    async change(input: Change) { const result = message(); child.send(input); return await result as Result; },
    async close() { child.send('close'); await exited; },
  };
}

test('SQLite CAS holds across independent management processes and preserves concurrent unrelated bindings', { timeout: 30_000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'studio-binding-cas-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, 'studio.sqlite');
  const storage = createStudioStorage({ kind: 'sqlite', path });
  t.after(() => storage.close());
  const db = await storage.open<SecretDatabase>('studio', studioCoreMigrations);
  await db.insertInto('studio_pets').values({ pet_id: 'a', definition_id: 'shared', name: 'A', created_at: 'now' }).execute();
  const management = createStudioSecrets(async () => db, Buffer.alloc(32, 107)).management;
  for (const secretId of ['old', 'new', 'other']) await management.put({ secretId, name: secretId, value: `fake-${secretId}` });
  // Open replicas sequentially so migrations are not part of the race under test.
  const first = await independentProcess(t, path), second = await independentProcess(t, path);
  const change = (envName: string, secretId: string | null, expectedSecretId: string | null): Change => ({ petId: 'a', envName, secretId, expectedSecretId });
  const initial = await Promise.all([first.change(change('TOKEN', 'old', null)), second.change(change('TOKEN', 'other', null))]);
  assert.deepEqual(initial.map(result => result.ok).sort(), [false, true]);
  assert.equal(initial.find(result => !result.ok)?.code, 'conflict');
  const current = (await management.bindings('a')).TOKEN!;
  assert.deepEqual(await Promise.all([first.change(change('LEFT', 'old', null)), second.change(change('RIGHT', 'other', null))]), [{ ok: true }, { ok: true }]);
  assert.deepEqual(await management.bindings('a'), { TOKEN: current, LEFT: 'old', RIGHT: 'other' });
  const rotated = await Promise.all([first.change(change('TOKEN', 'new', current)), second.change(change('TOKEN', 'new', current))]);
  assert.deepEqual(rotated.map(result => result.ok).sort(), [false, true]);
  assert.equal(rotated.find(result => !result.ok)?.code, 'conflict');
  assert.deepEqual(await first.change(change('TOKEN', null, current)), { ok: false, code: 'conflict' });
  const removed = await Promise.all([first.change(change('TOKEN', null, 'new')), second.change(change('TOKEN', null, 'new'))]);
  assert.deepEqual(removed.map(result => result.ok).sort(), [false, true]);
  assert.equal(removed.find(result => !result.ok)?.code, 'conflict');
  assert.deepEqual(await first.change(change('LEFT', 'missing', 'old')), { ok: false, code: 'not_found' });
  assert.deepEqual(await management.bindings('a'), { LEFT: 'old', RIGHT: 'other' });
  await first.close(); await second.close();
});
