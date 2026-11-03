import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createHostArtifactStore } from 'pinpawo/host-runtime';
import { createStudioHttpPlugin, type StudioHttpPluginContext } from './studioHttpPlugin';

const authToken = 'artifact-test-token-at-least-16-characters';
const headers = { Authorization: `Bearer ${authToken}` };
function context(): StudioHttpPluginContext {
  return { dispatch: async () => { throw new Error('unused'); }, subscribe: () => () => undefined,
    listPets: () => [], hooks: { expose: () => () => undefined, contribute: () => () => undefined },
    clients: { ensure: async ({ clientId }: { clientId: string }) => ({ clientId }),
      authenticate: async (token: string) => token === 'client-key' ? { clientId: 'remote' } : undefined } as never };
}

test('Studio authenticated artifact route streams across workspaces and keeps client authorization and CORS', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'pinpawo-studio-artifact-http-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const publisher = createHostArtifactStore({ sessionRoot: join(root, 'publisher') }, { stored: {}, env: {} });
  const reader = createHostArtifactStore({ sessionRoot: join(root, 'reader') }, { stored: {}, env: {} });
  const ref = await publisher.put({ threadId: 'session:one', name: '报告.txt', mimeType: 'text/plain',
    body: new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('snapshot')); controller.close(); } }) });
  const plugin = createStudioHttpPlugin({ port: 0, authToken, allowedOrigins: ['https://console.example.test'],
    fetchArtifact: uri => reader.fetch(uri) });
  await plugin.start(context());
  t.after(() => plugin.stop());
  const endpoint = `http://127.0.0.1:${plugin.address()!.port}/agent-session/artifacts`;
  const target = `${endpoint}?uri=${encodeURIComponent(ref.uri)}`;
  assert.equal((await fetch(target)).status, 401);
  assert.equal((await fetch(target, { headers: { Authorization: 'Bearer wrong' } })).status, 401);
  assert.equal((await fetch(target, { headers: { ...headers, Origin: 'https://untrusted.example' } })).status, 403);
  assert.equal((await fetch(target, { headers, method: 'POST' })).status, 405);
  for (const uri of ['', 'https://example.test/file', 'artifact://bad/%2f/key/file', 'artifact://short']) {
    assert.equal((await fetch(`${endpoint}?uri=${encodeURIComponent(uri)}`, { headers })).status, 400);
  }
  assert.equal((await fetch(`${endpoint}?uri=${encodeURIComponent(ref.uri.replace(/\/[^/]+\/[^/]+$/, '/00000000-0000-4000-8000-000000000000/missing.txt'))}`, { headers })).status, 404);
  const response = await fetch(target, { headers: { Authorization: 'Bearer client-key', Origin: 'https://console.example.test' } });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('Content-Type'), 'text/plain');
  assert.equal(response.headers.get('Content-Disposition'), `attachment; filename*=UTF-8''${encodeURIComponent('报告.txt')}`);
  assert.equal(response.headers.get('Cache-Control'), 'no-store');
  assert.equal(response.headers.get('Access-Control-Allow-Origin'), 'https://console.example.test');
  assert.match(response.headers.get('Access-Control-Expose-Headers') ?? '', /Content-Disposition/i);
  assert.equal(await response.text(), 'snapshot');
});

test('Studio artifact route redirects signed downloads and does not expose adapter failure details', async (t) => {
  const uri = 'artifact://workspace/session/artifact/report.txt';
  const url = 'https://cos.example.test/report?signature=temporary';
  let calls = 0;
  const plugin = createStudioHttpPlugin({ port: 0, authToken, fetchArtifact: async requested => {
    calls += 1;
    if (requested.endsWith('/failure')) throw new Error('private adapter detail');
    return { ref: { uri, name: 'report.txt', mimeType: 'text/plain', size: 5, sha256: 'a'.repeat(64), createdAt: new Date().toISOString() },
      url, expiresAt: new Date(Date.now() + 3600000).toISOString() };
  } });
  await plugin.start(context());
  t.after(() => plugin.stop());
  const endpoint = `http://127.0.0.1:${plugin.address()!.port}/agent-session/artifacts?uri=`;
  assert.equal((await fetch(endpoint + encodeURIComponent(uri), { redirect: 'manual' })).status, 401);
  assert.equal(calls, 0);
  const response = await fetch(endpoint + encodeURIComponent(uri), { headers, redirect: 'manual' });
  assert.equal(response.status, 302);
  assert.equal(response.headers.get('Location'), url);
  assert.equal(response.headers.get('Cache-Control'), 'no-store');
  const failure = await fetch(endpoint + encodeURIComponent('artifact://workspace/session/artifact/failure'), { headers });
  assert.equal(failure.status, 500);
  assert.doesNotMatch(await failure.text(), /private adapter detail/);
});
