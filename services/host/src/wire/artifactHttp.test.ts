import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { ArtifactRef } from '@pinpawo/agent-contracts';
import { FileArtifactStore } from '../artifactStore';
import { startResidentPetAgentSessionTransport } from './agentSessionRoute';
import { startHostServer } from '../server';
import { createTestModelServerDeps } from '../testing/modelProfiles';
import { buildHostRuntimeConfig } from '../config/runtimeConfig';

const token = 'artifact-http-test-token';
const headers = { Authorization: `Bearer ${token}` };

test('standalone Chat Host opens artifacts through its ordinary authenticated HTTP listener', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'pinpawo-chat-artifact-http-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const runtimeConfig = { ...buildHostRuntimeConfig(root), sessionRoot: join(root, 'workspace'),
    checkpointPath: join(root, 'checkpoints.json'), tuiCheckpointPath: join(root, 'tui-checkpoints.json'), tuiSessionPath: join(root, 'sessions.json') };
  const store = new FileArtifactStore(root, 'workspace');
  const ref = await store.put({ threadId: 'chat-session', name: 'report.txt', mimeType: 'text/plain',
    body: new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('Chat artifact')); controller.close(); } }) });
  const transport = await startHostServer(0, { petId: 'chat', runtimeConfig, ...createTestModelServerDeps() }, { authToken: token });
  t.after(async () => { transport.close(); await transport.closed; });
  const base = `http://127.0.0.1:${transport.port}`;
  const target = `${base}/agent-session/artifacts?uri=${encodeURIComponent(ref.uri)}`;
  assert.equal((await fetch(target)).status, 401);
  const response = await fetch(target, { headers });
  assert.equal(response.status, 200);
  assert.equal(await response.text(), 'Chat artifact');
  const runtime = await fetch(`${base}/runtime`, { headers });
  assert.equal(runtime.status, 200);
  assert.deepEqual(await runtime.json(), { ok: true });
});

test('authenticated Agent Session HTTP streams a published snapshot and rejects invalid targets', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'pinpawo-artifact-http-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const publisher = new FileArtifactStore(root, 'publisher');
  const reader = new FileArtifactStore(root, 'reader');
  const bytes = new TextEncoder().encode('A published snapshot.\n');
  const ref = await publisher.put({ threadId: 'pet:session/one', name: '报告.txt', mimeType: 'text/plain',
    body: new ReadableStream({ start(controller) { controller.enqueue(bytes); controller.close(); } }) });
  const transport = await startResidentPetAgentSessionTransport(0, new Map(), {
    authToken: token, log: () => undefined, logError: () => undefined,
    fetchArtifact: uri => reader.fetch(uri),
  });
  t.after(async () => { transport.close(); await transport.closed; });
  const endpoint = `http://127.0.0.1:${transport.port}/agent-session/artifacts`;
  const target = `${endpoint}?uri=${encodeURIComponent(ref.uri)}`;
  assert.equal((await fetch(target)).status, 401);
  assert.equal((await fetch(target, { headers: { Authorization: 'Bearer wrong' } })).status, 401);
  assert.equal((await fetch(target, { headers: { ...headers, Origin: 'https://untrusted.example' } })).status, 403);
  assert.equal((await fetch(target, { headers, method: 'POST' })).status, 405);
  for (const uri of ['', 'https://example.com/report', 'artifact://../escape', 'artifact://bad/%2f/key/file', 'artifact://too/short']) {
    assert.equal((await fetch(`${endpoint}?uri=${encodeURIComponent(uri)}`, { headers })).status, 400);
  }
  const missing = ref.uri.replace(/\/[^/]+\/[^/]+$/, '/00000000-0000-4000-8000-000000000000/missing.txt');
  assert.equal((await fetch(`${endpoint}?uri=${encodeURIComponent(missing)}`, { headers })).status, 404);
  const response = await fetch(target, { headers });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('Content-Type'), 'text/plain');
  assert.equal(response.headers.get('Content-Length'), String(bytes.length));
  assert.equal(response.headers.get('Content-Disposition'), `attachment; filename*=UTF-8''${encodeURIComponent('报告.txt')}`);
  assert.equal(response.headers.get('Cache-Control'), 'no-store');
  assert.equal(response.headers.get('X-Content-Type-Options'), 'nosniff');
  assert.deepEqual(new Uint8Array(await response.arrayBuffer()), bytes);
  assert.deepEqual(await reader.list('pet:session/one'), [], 'opening a shared URI does not expose the publisher inventory');
});

test('Agent Session HTTP redirects object storage only after authentication and reports adapter failures', async (t) => {
  const ref: ArtifactRef = { uri: 'artifact://workspace/session/artifact/report.txt', name: 'report.txt',
    mimeType: 'text/plain', size: 5, sha256: 'a'.repeat(64), createdAt: '2026-01-01T00:00:00.000Z' };
  const signed = 'https://objects.example.test/report?signature=ephemeral';
  let calls = 0;
  const transport = await startResidentPetAgentSessionTransport(0, new Map(), {
    authToken: token, log: () => undefined, logError: () => undefined,
    fetchArtifact: async uri => {
      calls += 1;
      if (uri.endsWith('/failure')) throw new Error('private adapter detail');
      return { ref, url: signed, expiresAt: '2026-01-01T01:00:00.000Z' };
    },
  });
  t.after(async () => { transport.close(); await transport.closed; });
  const endpoint = `http://127.0.0.1:${transport.port}/agent-session/artifacts?uri=`;
  assert.equal((await fetch(endpoint + encodeURIComponent(ref.uri), { redirect: 'manual' })).status, 401);
  assert.equal(calls, 0);
  const redirected = await fetch(endpoint + encodeURIComponent(ref.uri), { headers, redirect: 'manual' });
  assert.equal(redirected.status, 302);
  assert.equal(redirected.headers.get('Location'), signed);
  assert.equal(redirected.headers.get('Cache-Control'), 'no-store');
  const failed = await fetch(endpoint + encodeURIComponent('artifact://workspace/session/artifact/failure'), { headers });
  assert.equal(failed.status, 500);
  assert.doesNotMatch(await failed.text(), /private adapter detail/);
});
