import assert from 'node:assert/strict';
import { chmod, mkdtemp, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { FilePetCredentialSource } from './filePetCredentialSource';
import { resolvePetCredentialEnvironment, withPetExecutionIdentity } from './petCredentials';

async function fixture(t: import('node:test').TestContext) {
  const dir = await mkdtemp(join(tmpdir(), 'pet-credentials-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'credentials.json');
  const save = async (value: unknown) => {
    const next = `${path}.next`;
    await writeFile(next, JSON.stringify(value), { mode: 0o600 });
    await rename(next, path);
  };
  await save({ bindings: { a: { TEST_TOKEN: 'a' }, b: { TEST_TOKEN: 'b' }, empty: {} }, values: { a: 'fake-a', b: 'fake-b' } });
  return { path, save };
}

test('persistent instance references survive reconstruction; concurrent sessions share only their instance', async (t) => {
  const { path, save } = await fixture(t);
  const resolve = (petId: string) => withPetExecutionIdentity(petId, () => resolvePetCredentialEnvironment(new FilePetCredentialSource(path)));
  const values = await Promise.all(['a', 'b', 'a'].map(resolve));
  assert.deepEqual(values.map((env) => env.TEST_TOKEN), ['fake-a', 'fake-b', 'fake-a']);
  assert.equal(process.env.TEST_TOKEN, undefined);
  await save({ bindings: { a: { TEST_TOKEN: 'replacement' } }, values: { replacement: 'fake-new' } });
  assert.equal((await resolve('a')).TEST_TOKEN, 'fake-new');
  await assert.rejects(resolve('b'), /resolution failed/);
});

test('missing context, instance, reference, invalid binding and provider exceptions fail without leaking values', async (t) => {
  const { path, save } = await fixture(t);
  const source = new FilePetCredentialSource(path);
  await assert.rejects(resolvePetCredentialEnvironment(source), /active instance/);
  await assert.rejects(withPetExecutionIdentity('missing', () => resolvePetCredentialEnvironment(source)), /resolution failed/);
  assert.deepEqual(Object.keys(await withPetExecutionIdentity('empty', () => resolvePetCredentialEnvironment(source))), []);
  for (const binding of [{ TEST_TOKEN: 'missing' }, { 'BAD=NAME': 'a' }, { TEST_TOKEN: 1 }]) {
    await save({ bindings: { a: binding }, values: { a: 'fake-secret' } });
    await assert.rejects(withPetExecutionIdentity('a', () => resolvePetCredentialEnvironment(source)), /resolution failed/);
  }
  const broken = { readBindings: async () => { throw new Error('fake-secret'); }, resolve: async () => '' };
  await assert.rejects(withPetExecutionIdentity('a', () => resolvePetCredentialEnvironment(broken)), (error: Error) => {
    assert.equal(error.message, 'Pet credential resolution failed; command was not started.');
    assert.equal(error.cause, undefined);
    return true;
  });
});

test('protected file rejects public permissions, malformed data and symlinks', { skip: process.platform === 'win32' }, async (t) => {
  const { path } = await fixture(t);
  const source = new FilePetCredentialSource(path);
  await chmod(path, 0o644);
  await assert.rejects(source.readBindings('a'), /unavailable or invalid/);
  await chmod(path, 0o600);
  await writeFile(path, 'fake-secret malformed json');
  await assert.rejects(source.readBindings('a'), /unavailable or invalid/);
  await symlink(path, `${path}.link`);
  await assert.rejects(new FilePetCredentialSource(`${path}.link`).readBindings('a'), /unavailable or invalid/);
});

test('retained async descendants cannot resolve credentials after the instance turn settles', async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let late!: Promise<unknown>;
  await withPetExecutionIdentity('a', async () => {
    late = gate.then(() => resolvePetCredentialEnvironment({ readBindings: async () => ({}), resolve: async () => '' }));
  });
  release();
  await assert.rejects(late, /active instance/);
});
