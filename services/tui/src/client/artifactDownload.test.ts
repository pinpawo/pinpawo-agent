import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { downloadArtifact } from './artifactDownload';

const uri = 'artifact://workspace/session/object/report%20(1).bin';
const token = 'fixture-client-token';

async function listen(handler: (request: IncomingMessage, response: ServerResponse) => void) {
  const server = createServer(handler);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  return { port: address.port, url: `http://127.0.0.1:${address.port}`, async close() {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  } };
}

test('explicit download authenticates the Host and saves remote bytes in a private client file', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pinpawo-download-test-'));
  const bytes = Buffer.from([0, 1, 10, 127, 255]);
  const host = await listen((request, response) => {
    if (request.headers.authorization !== `Bearer ${token}`) { response.writeHead(401).end(); return; }
    const url = new URL(request.url!, 'http://fixture');
    assert.equal(url.pathname, '/agent-session/artifacts');
    assert.equal(url.searchParams.get('uri'), uri);
    response.writeHead(200, { 'Content-Length': bytes.length, 'X-Remote-Path': '/srv/host-only/report.bin' }).end(bytes);
  });
  try {
    assert.equal((await fetch(`${host.url}/agent-session/artifacts?${new URLSearchParams({ uri })}`)).status, 401);
    const options = { port: host.port, tokenProvider: () => token, tempRoot: root };
    const path = await downloadArtifact(uri, options);
    assert.ok(path.startsWith(`${root}/`));
    assert.ok(!path.includes('/srv/host-only'));
    assert.deepEqual(await readFile(path), bytes);
    const second = await downloadArtifact(uri, options);
    assert.notEqual(path, second);
    assert.deepEqual(await readFile(path), bytes);
    if (process.platform !== 'win32') {
      assert.equal((await stat(path)).mode & 0o777, 0o600);
      assert.equal((await stat(dirname(path))).mode & 0o777, 0o700);
    }
  } finally { await host.close(); await rm(root, { recursive: true, force: true }); }
});

test('object redirects and source URLs are downloaded without Host Bearer or cookies', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pinpawo-download-cos-'));
  const seen: IncomingMessage['headers'][] = [];
  const object = await listen((request, response) => {
    seen.push(request.headers);
    if (request.url === '/object') { response.writeHead(307, { Location: '/snapshot?signature=fixture' }).end(); return; }
    response.end('published bytes');
  });
  const host = await listen((request, response) => {
    assert.equal(request.headers.authorization, `Bearer ${token}`);
    response.writeHead(302, { Location: `${object.url}/object` }).end();
  });
  try {
    const path = await downloadArtifact(uri, { port: host.port, tokenProvider: () => token, tempRoot: root });
    assert.equal(await readFile(path, 'utf8'), 'published bytes');
    const direct = await downloadArtifact(uri, { sourceUrl: `${object.url}/object`, tempRoot: root,
      tokenProvider: () => assert.fail('A source URL must not read Host credentials.') });
    assert.equal(await readFile(direct, 'utf8'), 'published bytes');
    assert.equal(seen.length, 4);
    for (const headers of seen) {
      assert.equal(headers.authorization, undefined);
      assert.equal(headers.cookie, undefined);
    }
  } finally { await host.close(); await object.close(); await rm(root, { recursive: true, force: true }); }
});

test('invalid references, addresses and missing credentials never issue a request', async () => {
  const never = async () => assert.fail('No request expected.');
  for (const reference of ['https://example.test/file', 'artifact://a/../file', 'artifact://a/%2F/file', 'artifact://']) {
    await assert.rejects(downloadArtifact(reference, { fetch: never, tokenProvider: () => token }), /Invalid artifact URI/);
  }
  for (const sourceUrl of ['file:///tmp/report', 'data:text/plain,a', 'https://user:pass@example.test/file']) {
    await assert.rejects(downloadArtifact(uri, { sourceUrl, fetch: never }), /Invalid artifact download address/);
  }
  await assert.rejects(downloadArtifact(uri, { tokenProvider: () => null, fetch: never }), /auth token is unavailable/);
});

test('opaque keys and long Unicode names produce usable private filenames', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pinpawo-download-name-'));
  try {
    for (const reference of ['artifact://opaque-key', `artifact://workspace/session/object/${encodeURIComponent('报'.repeat(100))}.txt`]) {
      const path = await downloadArtifact(reference, { tempRoot: root, tokenProvider: () => token,
        fetch: async () => new Response(new ReadableStream<Uint8Array>({ start(controller) {
          controller.enqueue(new TextEncoder().encode('by'));
          controller.enqueue(new TextEncoder().encode('tes'));
          controller.close();
        } }), { headers: { 'Content-Length': '5' } }) });
      assert.equal(await readFile(path, 'utf8'), 'bytes');
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('failed responses, unsafe redirects and redirect loops leave no local file', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pinpawo-download-failed-'));
  try {
    const options = { tempRoot: root, tokenProvider: () => token };
    await assert.rejects(downloadArtifact(uri, { ...options, fetch: async () => new Response(null, { status: 404 }) }), /failed \(404\)/);
    await assert.rejects(downloadArtifact(uri, { ...options, fetch: async () => { throw new Error('secret signed URL'); } }),
      error => error instanceof Error && error.message === 'Artifact download request failed.');
    await assert.rejects(downloadArtifact(uri, { ...options,
      fetch: async () => new Response(null, { status: 302, headers: { Location: 'file:///private/file' } }) }), /Invalid artifact download address/);
    let calls = 0;
    await assert.rejects(downloadArtifact(uri, { ...options, fetch: async (_input, init) => {
      assert.equal(new Headers(init?.headers).get('Authorization'), calls++ === 0 ? `Bearer ${token}` : null);
      return new Response(null, { status: 302, headers: { Location: 'https://objects.example.test/loop' } });
    } }), /Too many artifact download redirects/);
    assert.equal(calls, 6);
    assert.deepEqual(await readdir(root), []);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('declared and streamed size limits cancel the body and remove partial output', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pinpawo-download-limit-'));
  try {
    let cancelled = 0;
    const declared = new ReadableStream<Uint8Array>({ cancel() { cancelled += 1; } });
    await assert.rejects(downloadArtifact(uri, { tempRoot: root, tokenProvider: () => token,
      fetch: async () => new Response(declared, { headers: { 'Content-Length': '100000001' } }) }), /exceeds 100 MB/);
    assert.equal(cancelled, 1);
    let pulls = 0;
    const streaming = new ReadableStream<Uint8Array>({
      pull(controller) { controller.enqueue(pulls++ === 0 ? new Uint8Array(3) : new Uint8Array(100_000_000)); },
      cancel() { cancelled += 1; },
    }, { highWaterMark: 0 });
    await assert.rejects(downloadArtifact(uri, { tempRoot: root, tokenProvider: () => token,
      fetch: async () => new Response(streaming) }), /exceeds 100 MB/);
    assert.equal(cancelled, 2);
    assert.deepEqual(await readdir(root), []);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('a broken stream removes its partial file and does not expose the remote error', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pinpawo-download-partial-'));
  let pulls = 0;
  const body = new ReadableStream<Uint8Array>({ pull(controller) {
    if (pulls++ === 0) controller.enqueue(new Uint8Array([1, 2, 3]));
    else controller.error(new Error('https://objects.example.test/file?signature=secret'));
  } }, { highWaterMark: 0 });
  try {
    await assert.rejects(downloadArtifact(uri, { tempRoot: root, tokenProvider: () => token,
      fetch: async () => new Response(body) }), error => error instanceof Error && error.message === 'Artifact download could not be saved.');
    assert.deepEqual(await readdir(root), []);
  } finally { await rm(root, { recursive: true, force: true }); }
});
