import assert from 'node:assert/strict';
import test from 'node:test';
import { createStudio } from '@pinpawo/studio-core';
import { createStudioHttpPlugin } from '@pinpawo-plugin/studio-http';

const token = 'fake-local-management-token';
test('Secret HTTP management is local-only and every successful response contains metadata or references, never values', async () => {
  const http = createStudioHttpPlugin({ authToken: token, port: 0 });
  const studio = await createStudio({ studioId: 'secret-http-test', secretsKey: Buffer.alloc(32, 0x6b),
    plugins: [http], definitions: [{ definitionId: 'shared', name: 'Shared' }],
    assemblePet: async () => ({
      dispatch: { dispatch: async () => {}, onDispatchLifecycle: () => () => {}, onQueueChange: () => () => {},
        getQueueSnapshot: () => ({ state: 'open', activeOperation: null, queuedConversations: 0, queuedDispatches: 0 }) },
      close: async () => {},
    }),
  });
  const base = `http://127.0.0.1:${http.address()!.port}`;
  const request = (path: string, body?: unknown, key = token) => fetch(`${base}${path}`, {
    method: body === undefined ? 'GET' : 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const patch = (body: unknown, key = token) => fetch(`${base}/pet-credentials`, {
    method: 'PATCH', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  const secretValue = 'fake-http-business-credential';
  try {
    const created = await request('/pets', { petId: 'a', definitionId: 'shared', name: 'A' });
    assert.equal(created.status, 201);
    const client = await request('/clients', { clientId: 'ordinary', label: 'Ordinary' });
    const { key } = await client.json() as { key: string };
    assert.ok(key);
    const saved = await request('/secrets', { secretId: 'account', name: 'Account', value: secretValue });
    assert.equal(saved.status, 200);
    const savedText = await saved.text();
    assert.equal(savedText.includes(secretValue), false);
    assert.deepEqual(Object.keys(JSON.parse(savedText).secret).sort(), ['createdAt', 'name', 'secretId', 'updatedAt']);
    const bound = await request('/pet-credentials', { petId: 'a', bindings: { SERVICE_TOKEN: 'account' } });
    assert.equal(bound.status, 200);
    assert.deepEqual(await bound.json(), { bindings: { SERVICE_TOKEN: 'account' } });
    await request('/secrets', { secretId: 'rotated', name: 'Rotated', value: 'fake-rotated-value' });
    const change = { petId: 'a', envName: 'SERVICE_TOKEN', secretId: 'rotated', expectedSecretId: 'account' };
    const other = await patch({ petId: 'a', envName: 'OTHER_TOKEN', secretId: 'account', expectedSecretId: null });
    assert.equal(other.status, 200);
    const rotated = await patch(change);
    assert.equal(rotated.status, 200);
    assert.deepEqual(await rotated.json(), { binding: { petId: 'a', envName: 'SERVICE_TOKEN', secretId: 'rotated' } });
    const conflict = await patch(change);
    assert.equal(conflict.status, 409);
    assert.equal((await conflict.text()).includes(secretValue), false);
    assert.equal((await patch({ ...change, secretId: null })).status, 409);
    assert.equal((await patch({ ...change, secretId: 'missing', expectedSecretId: 'rotated' })).status, 404);
    assert.equal((await patch({ petId: 'a', envName: 'SERVICE_TOKEN', secretId: 'account' })).status, 400);
    assert.equal((await patch({ ...change, expectedSecretId: 'rotated' }, key)).status, 403);
    assert.deepEqual(await (await request('/pet-credentials?petId=a')).json(), { bindings: { SERVICE_TOKEN: 'rotated', OTHER_TOKEN: 'account' } });
    assert.equal((await patch({ ...change, secretId: null, expectedSecretId: 'rotated' })).status, 200);
    assert.equal((await patch({ ...change, secretId: 'account', expectedSecretId: null })).status, 200);
    assert.equal((await patch({ petId: 'a', envName: 'OTHER_TOKEN', secretId: null, expectedSecretId: 'account' })).status, 200);
    for (const path of ['/secrets', '/pet-credentials?petId=a']) {
      const metadata = await request(path);
      assert.equal(metadata.status, 200);
      assert.equal((await metadata.text()).includes(secretValue), false);
      assert.equal((await request(path, undefined, key)).status, 403);
      assert.equal((await request(path, undefined, 'fake-invalid')).status, 401);
    }
    assert.equal((await request('/secrets', { secretId: 'account', name: 'Hacked', value: 'fake-client-write' }, key)).status, 403);
    assert.equal((await request('/pet-credentials', { petId: 'a', bindings: {} }, key)).status, 403);
    const invalid = await request('/pet-credentials', { petId: 'a', bindings: { SERVICE_TOKEN: 'missing' } });
    assert.equal(invalid.status, 404);
    assert.equal((await invalid.text()).includes(secretValue), false);
    assert.deepEqual(await (await request('/pet-credentials?petId=a')).json(), { bindings: { SERVICE_TOKEN: 'account' } });
    // There is no decrypted-value read endpoint, including for the local token.
    assert.equal((await request('/secrets/account')).status, 404);
  } finally { await studio.shutdown(); }
});

test('Secret HTTP writes fail locked without a deployment key and never fall back to plaintext', async () => {
  const http = createStudioHttpPlugin({ authToken: token, port: 0 });
  const studio = await createStudio({ studioId: 'locked-secret-http', plugins: [http], definitions: [],
    assemblePet: async () => { throw Error('unused'); } });
  const url = `http://127.0.0.1:${http.address()!.port}/secrets`;
  const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
  try {
    const saved = await fetch(url, { method: 'POST', headers, body: JSON.stringify({ secretId: 'a', name: 'A', value: 'fake-locked-value' }) });
    assert.equal(saved.status, 503);
    assert.equal((await saved.text()).includes('fake-locked-value'), false);
    assert.deepEqual(await (await fetch(url, { headers })).json(), { unlocked: false, secrets: [] });
  } finally { await studio.shutdown(); }
});
