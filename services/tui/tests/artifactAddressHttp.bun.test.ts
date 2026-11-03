import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { handleAgentSessionHttp } from '../../host/src/wire/agentSessionHttp';
import { artifactHttpAddress } from '../src/client/artifactAddress';
import { buildMessageDisplayLines } from '../src/timeline/messageDisplay';
import { formatTranscriptPagerText } from '../src/transcript/transcriptPager';

test('a connected TUI displays its real artifact GET address while authentication stays on the request', async (t) => {
  const uri = 'artifact://workspace/session/id/hello%20world.txt';
  const bytes = new TextEncoder().encode('Published report.');
  const token = 'tui-artifact-address-fixture';
  const server = createServer((request, response) => {
    void handleAgentSessionHttp(request, response, new Map(), token, async received => {
      assert.equal(received, uri);
      return { ref: { uri, name: 'hello world.txt', mimeType: 'text/plain', size: bytes.length,
        sha256: createHash('sha256').update(bytes).digest('hex'), createdAt: new Date().toISOString() },
      body: new ReadableStream({ start(controller) { controller.enqueue(bytes); controller.close(); } }) };
    });
  });
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  t.after(() => new Promise<void>(done => server.close(() => done())));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const url = artifactHttpAddress(uri, address.port);
  assert.equal(new URL(url).searchParams.get('uri'), uri);
  assert.equal(url.includes(token), false);
  assert.equal((await fetch(url)).status, 401);
  const response = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  assert.equal(response.status, 200);
  assert.deepEqual(new Uint8Array(await response.arrayBuffer()), bytes);
  const entry = { id: 'reply', type: 'message' as const, role: 'assistant' as const, text: 'Done.', status: 'completed' as const,
    deliverables: [{ uri, title: 'Report' }] };
  const artifactAddress = (value: string) => artifactHttpAddress(value, address.port);
  assert.equal(buildMessageDisplayLines(entry, { artifactAddress })[1]?.text, `↳ Report · ${url}`);
  const transcript = formatTranscriptPagerText({ sessionId: 'test', kind: 'chat', timeline: [entry], activeRun: null, pendingInterrupt: null }, artifactAddress);
  assert.ok(transcript.includes(url));
  assert.equal(transcript.includes(token), false);
  assert.equal(entry.deliverables[0]?.uri, uri, 'display resolution never rewrites the saved reference');
  assert.equal(artifactHttpAddress('https://example.com/pull/1', address.port), 'https://example.com/pull/1');
});
