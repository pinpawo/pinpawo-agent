import assert from 'node:assert/strict';
import test from 'node:test';
import { resolvePetCredentialEnvironment, withPetExecutionIdentity, type PetCredentialSource } from './petCredentials';

const source: PetCredentialSource = {
  environment: async (petId) => {
    if (petId === 'missing') throw new Error('fake-secret');
    return petId === 'empty' ? {} : { TEST_TOKEN: `fake-${petId}` } as Record<string, string>;
  },
};

test('concurrent turns resolve only their own Pet', async () => {
  const resolve = (petId: string) => withPetExecutionIdentity(petId, () => resolvePetCredentialEnvironment(source));
  const values = await Promise.all(['a', 'b', 'a'].map(resolve));
  assert.deepEqual(values.map((env) => env.TEST_TOKEN), ['fake-a', 'fake-b', 'fake-a']);
  assert.deepEqual(Object.keys(await resolve('empty')), []);
  assert.equal(process.env.TEST_TOKEN, undefined);
});

test('no turn, a failing source or an invalid variable fails without leaking the cause', async () => {
  await assert.rejects(resolvePetCredentialEnvironment(source), /active Pet turn/);
  await assert.rejects(withPetExecutionIdentity('missing', () => resolvePetCredentialEnvironment(source)), (error: Error) => {
    assert.equal(error.message, 'Pet credential resolution failed; command was not started.');
    assert.equal(error.cause, undefined);
    return true;
  });
  const invalid: PetCredentialSource = { environment: async () => ({ 'BAD=NAME': 'fake' }) };
  await assert.rejects(withPetExecutionIdentity('a', () => resolvePetCredentialEnvironment(invalid)), /resolution failed/);
});

test('async work kept past the turn cannot resolve credentials', async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let late!: Promise<unknown>;
  await withPetExecutionIdentity('a', async () => {
    late = gate.then(() => resolvePetCredentialEnvironment(source));
  });
  release();
  await assert.rejects(late, /active Pet turn/);
});
