import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import type { ArtifactRef } from '@pinpawo/agent-contracts';
import { startResidentPetAgentSessionTransport } from '../wire/agentSessionRoute';
import { handleLocalHttpRequest } from '../httpHandlers';

const uri = 'artifact://workspace/session/id/report.txt';
const ref: ArtifactRef = { uri, name: 'report.txt', mimeType: 'text/plain', size: 6, sha256: 'hash', createdAt: '2026-11-05T00:00:00Z' };

test('local Chat HTTP opens the same authenticated artifact route', async () => {
  const server = createServer((request, response) => {
    handleLocalHttpRequest(request, response, { authToken: 'secret', artifactStore: {
      fetch: async () => ({ ref, body: new ReadableStream({ start(controller) {
        controller.enqueue(new TextEncoder().encode('report')); controller.close();
      } }) }),
    } });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  try {
    const response = await fetch(`http://127.0.0.1:${address.port}/agent-session/artifacts?uri=${encodeURIComponent(uri)}`, {
      headers: { Authorization: 'Bearer secret' },
    });
    assert.equal(response.status, 200);
    assert.equal(await response.text(), 'report');
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});

test('artifact HTTP route authenticates, validates, streams snapshots, and redirects COS downloads', async () => {
  const transport = await startResidentPetAgentSessionTransport(0, new Map(), {
    authToken: 'secret', log: () => undefined,
    artifactStore: { fetch: async (value) => {
      if (value.endsWith('/missing.txt')) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
      if (value.endsWith('/signed.txt')) return { ref, url: 'https://bucket.example/signed?key=temporary', expiresAt: '2026-11-05T00:15:00Z' };
      return { ref, body: new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('report')); controller.close(); } }) };
    } },
  });
  const base = `http://127.0.0.1:${transport.port}/agent-session/artifacts?uri=`;
  const headers = { Authorization: 'Bearer secret' };
  try {
    assert.equal((await fetch(base + encodeURIComponent(uri))).status, 401);
    assert.equal((await fetch(base + encodeURIComponent('artifact://workspace/../secret'), { headers })).status, 400);
    assert.equal((await fetch(base + encodeURIComponent(uri.replace('report.txt', 'missing.txt')), { headers })).status, 404);
    const response = await fetch(base + encodeURIComponent(uri), { headers });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'text/plain');
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(await response.text(), 'report');
    const redirect = await fetch(base + encodeURIComponent(uri.replace('report.txt', 'signed.txt')), { headers, redirect: 'manual' });
    assert.equal(redirect.status, 302);
    assert.equal(redirect.headers.get('location'), 'https://bucket.example/signed?key=temporary');
    assert.equal((await fetch(base + encodeURIComponent(uri), { method: 'POST', headers })).status, 405);
  } finally { transport.close(); await transport.closed; }
});
