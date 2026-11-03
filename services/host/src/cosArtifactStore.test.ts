import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { Readable } from 'node:stream';
import test from 'node:test';
import COS from 'cos-nodejs-sdk-v5';
import { MAX_ARTIFACT_BYTES } from '@pinpawo-toolkit/artifacts';
import { CosArtifactStore, type CosArtifactClient, type CosArtifactStoreOptions } from './cosArtifactStore';

const options: CosArtifactStoreOptions = {
  workspaceId: 'local-fixture', bucket: 'artifact-fixture-1250000000', region: 'ap-guangzhou',
  prefix: 'snapshots', secretId: 'AKID_OFFLINE_FIXTURE', secretKey: 'offline-fixture-not-a-real-secret',
};

function body(bytes: Uint8Array | string): ReadableStream<Uint8Array> {
  return new ReadableStream({ start(controller) {
    controller.enqueue(typeof bytes === 'string' ? Buffer.from(bytes) : bytes);
    controller.close();
  } });
}

function input(bytes: Uint8Array | string = 'report') {
  return { threadId: 'thread/with space', name: '报告.md', mimeType: 'text/markdown', body: body(bytes) };
}

class MemoryCos implements CosArtifactClient {
  readonly objects = new Map<string, Buffer>();
  readonly puts: COS.PutObjectParams[] = [];
  readonly gets: COS.GetObjectParams[] = [];
  readonly deletes: string[] = [];
  readonly pages: COS.GetBucketParams[] = [];
  readonly signatures: COS.GetObjectUrlParams[] = [];
  readonly canceled: string[] = [];
  failContent = false;
  failMetadata = false;
  retainContent = true;
  pageSize = 1_000;

  async putObject(params: COS.PutObjectParams): Promise<unknown> {
    this.puts.push(params);
    const metadata = params.Key.includes('/.metadata/');
    if (metadata && this.failMetadata) throw new Error('metadata unavailable');
    if (!metadata) params.onTaskReady?.(`task-${this.puts.length}`);
    if (!metadata && this.failContent) throw new Error('upload unavailable');
    const chunks: Buffer[] = [];
    if (typeof params.Body === 'string' || params.Body instanceof String || Buffer.isBuffer(params.Body)) {
      chunks.push(Buffer.from(params.Body.valueOf() as string | Buffer));
    } else {
      for await (const chunk of params.Body as Readable) {
        if (metadata || this.retainContent) chunks.push(Buffer.from(chunk));
      }
    }
    this.objects.set(params.Key, Buffer.concat(chunks));
    return {};
  }

  async getObject(params: COS.GetObjectParams): Promise<{ Body: Buffer }> {
    this.gets.push(params);
    const bytes = this.objects.get(params.Key);
    if (!bytes) throw { statusCode: 404, code: 'NoSuchKey', message: 'Object not found.' };
    return { Body: bytes };
  }

  async deleteObject(params: COS.DeleteObjectParams): Promise<unknown> {
    this.deletes.push(params.Key);
    this.objects.delete(params.Key);
    return {};
  }

  async getBucket(params: COS.GetBucketParams) {
    this.pages.push(params);
    const keys = [...this.objects.keys()].filter(key => key.startsWith(params.Prefix ?? '')).sort();
    const start = params.Marker ? keys.findIndex(key => key === params.Marker) + 1 : 0;
    const selected = keys.slice(start, start + this.pageSize);
    const truncated = start + selected.length < keys.length;
    return { Contents: selected.map(Key => ({ Key })), IsTruncated: String(truncated),
      ...(truncated ? { NextMarker: selected.at(-1)! } : {}) };
  }

  getObjectUrl(params: COS.GetObjectUrlParams, callback: (error: unknown, result?: { Url: string }) => void) {
    this.signatures.push(params);
    callback(null, { Url: `https://signed.example.test/${encodeURIComponent(params.Key)}?signature=${this.signatures.length}` });
  }

  cancelTask(taskId: string): void { this.canceled.push(taskId); }
}

test('COS stores binary snapshots under stable keys and creates a new object on every publication', async () => {
  const client = new MemoryCos();
  const store = new CosArtifactStore(options, client);
  const bytes = Buffer.from([0, 1, 255, 0, 128]);
  const first = await store.put({ ...input(bytes), title: 'First snapshot' });
  bytes.fill(7);
  const second = await store.put(input(Buffer.from([0, 1, 255, 0, 128])));
  assert.notEqual(first.uri, second.uri);
  assert.equal(first.size, 5);
  assert.equal(first.sha256, createHash('sha256').update(Buffer.from([0, 1, 255, 0, 128])).digest('hex'));
  const content = [...client.objects].filter(([key]) => !key.includes('/.metadata/'));
  assert.equal(content.length, 2);
  assert.deepEqual(content[0]![1], Buffer.from([0, 1, 255, 0, 128]));
  assert.match(first.uri, /^artifact:\/\/local-fixture\/[A-Za-z0-9_-]+\/[a-f0-9-]+\//);
  assert.equal(client.puts[0]!.ContentLength, undefined, 'files go to SDK as streams with unknown length');
  assert.match(client.puts[0]!.ContentDisposition!, /filename\*=UTF-8''/);
  assert.deepEqual(JSON.parse([...client.objects].find(([key]) => key.includes('/.metadata/'))![1].toString()), first);
  assert.equal(client.signatures.length, 0, 'publication does not persist a signed URL');
});

test('COS accepts an empty file and validates publication names before uploading', async () => {
  const client = new MemoryCos();
  const store = new CosArtifactStore(options, client);
  const empty = await store.put(input(''));
  assert.equal(empty.size, 0);
  assert.equal(empty.sha256, createHash('sha256').update('').digest('hex'));
  for (const name of ['', '.', '..', '../escape', 'a/b', 'a\\b']) {
    await assert.rejects(store.put({ ...input(), name }), TypeError);
  }
  assert.equal(client.puts.length, 2);
});

test('COS listing follows every page and stays within the bound workspace and session', async () => {
  const client = new MemoryCos();
  client.pageSize = 1;
  const store = new CosArtifactStore(options, client);
  const first = await store.put(input('first'));
  const second = await store.put(input('second'));
  await store.put({ ...input('other'), threadId: 'other' });
  await new CosArtifactStore({ ...options, workspaceId: 'other-workspace' }, client).put(input('other workspace'));
  const refs = await store.list('thread/with space');
  assert.deepEqual(new Set(refs.map(ref => ref.uri)), new Set([first.uri, second.uri]));
  assert.equal(client.pages.length, 2);
  assert.ok(client.pages[1]!.Marker);
  assert.ok(client.pages.every(page => page.Prefix === `snapshots/local-fixture/${Buffer.from('thread/with space').toString('base64url')}/.metadata/`));
});

test('COS fetch resolves another session/workspace and creates only temporary signed URLs', async () => {
  const client = new MemoryCos();
  const publisher = new CosArtifactStore(options, client);
  const ref = await publisher.put(input('shared'));
  const reader = new CosArtifactStore({ ...options, workspaceId: 'reader' }, client);
  const before = Date.now();
  const first = await reader.fetch(ref.uri);
  const second = await reader.fetch(ref.uri);
  assert.deepEqual(first.ref, ref);
  assert.notEqual(first.url, second.url);
  assert.ok(Date.parse(first.expiresAt) >= before + 3_600_000);
  assert.ok(Date.parse(first.expiresAt) <= Date.now() + 3_600_000);
  assert.equal(client.signatures[0]!.Expires, 3_600);
  assert.equal(client.signatures[0]!.Protocol, 'https:');
  assert.equal(client.signatures[0]!.Method, 'GET');
  assert.equal(client.signatures[0]!.Sign, true);
  const refs = await publisher.list('thread/with space');
  assert.deepEqual(refs, [ref]);
  assert.ok([...client.objects.values()].every(bytes => !bytes.toString().includes('signed.example.test')));
});

test('COS maps missing objects to ENOENT and rejects corrupt or mismatched metadata', async () => {
  const client = new MemoryCos();
  const store = new CosArtifactStore(options, client);
  const ref = await store.put(input());
  await assert.rejects(store.fetch('artifact://local-fixture/dGhyZWFk/missing/file'), { code: 'ENOENT' });
  await assert.rejects(store.fetch(ref.uri.replace(/\/[^/]+$/, '/wrong-name')), { code: 'ENOENT' });
  const metadataKey = [...client.objects.keys()].find(key => key.includes('/.metadata/'))!;
  client.objects.set(metadataKey, Buffer.from('{broken json'));
  await assert.rejects(store.fetch(ref.uri), /Invalid stored artifact metadata/);
  await assert.rejects(store.list('thread/with space'), /Invalid stored artifact metadata/);
  await assert.rejects(store.fetch('artifact://local-fixture/../escape/file'), TypeError);
});

test('COS does not publish metadata after a source error or a failed upload', async () => {
  const client = new MemoryCos();
  const store = new CosArtifactStore(options, client);
  const aborted = new DOMException('Canceled publication', 'AbortError');
  const source = new ReadableStream<Uint8Array>({ start(controller) { controller.error(aborted); } });
  await assert.rejects(store.put({ ...input(), body: source }), { name: 'AbortError' });
  assert.equal(client.objects.size, 0);
  assert.equal(client.puts.filter(call => call.Key.includes('/.metadata/')).length, 0);
  assert.equal(client.canceled.length, 1);

  client.failContent = true;
  await assert.rejects(store.put(input()), /upload unavailable/);
  assert.equal(client.objects.size, 0);
  assert.equal(client.puts.filter(call => call.Key.includes('/.metadata/')).length, 0);
});

test('COS removes only this publication when metadata cannot be written', async () => {
  const client = new MemoryCos();
  const store = new CosArtifactStore(options, client);
  const existing = await store.put(input('already published'));
  client.failMetadata = true;
  await assert.rejects(store.put(input('failed')), /metadata unavailable/);
  client.failMetadata = false;
  assert.deepEqual(await store.list('thread/with space'), [existing]);
  assert.equal(client.deletes.length, 2);
  assert.equal(client.objects.size, 2);
});

test('COS enforces the exact byte limit with bounded streams, without buffering the test file', async () => {
  const client = new MemoryCos();
  client.retainContent = false;
  const store = new CosArtifactStore(options, client);
  const chunk = Buffer.alloc(1_000_000, 3);
  const generated = (length: number) => {
    let remaining = length;
    return new ReadableStream<Uint8Array>({ pull(controller) {
      if (remaining === 0) { controller.close(); return; }
      const next = Math.min(remaining, chunk.length);
      remaining -= next;
      controller.enqueue(chunk.subarray(0, next));
    } });
  };
  const ref = await store.put({ ...input(), body: generated(MAX_ARTIFACT_BYTES) });
  assert.equal(ref.size, MAX_ARTIFACT_BYTES);
  await assert.rejects(store.put({ ...input(), body: generated(MAX_ARTIFACT_BYTES + 1) }), /100 MB/);
  assert.deepEqual(await store.list('thread/with space'), [ref]);
});

test('COS rejects a nonadvancing pagination cursor rather than looping', async () => {
  const client = new MemoryCos();
  client.getBucket = async () => ({ Contents: [], IsTruncated: 'true', NextMarker: 'same' });
  await assert.rejects(new CosArtifactStore(options, client).list('thread'), /did not advance/);
});

test('the real SDK streams requests to an isolated HTTP fixture, signs offline and aborts failed sources', { timeout: 5_000 }, async t => {
  const objects = new Map<string, Buffer>();
  const requests: Array<{ method: string; key: string; authorization?: string }> = [];
  const server = createServer(async (request, response) => {
    const key = decodeURIComponent(new URL(request.url!, 'http://fixture').pathname.slice(1));
    requests.push({ method: request.method!, key, authorization: request.headers.authorization });
    if (request.method === 'PUT') {
      const chunks: Buffer[] = [];
      try { for await (const chunk of request) chunks.push(Buffer.from(chunk)); } catch {
        response.destroy(); return;
      }
      objects.set(key, Buffer.concat(chunks));
      response.writeHead(200, { ETag: '"offline"' }); response.end();
    } else if (request.method === 'GET' && objects.has(key)) {
      response.writeHead(200, { 'Content-Type': 'application/json' }); response.end(objects.get(key));
    } else { response.writeHead(404); response.end(); }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>((resolve, reject) => {
    server.closeAllConnections(); server.close(error => error ? reject(error) : resolve());
  }));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const sdk = new COS({ SecretId: options.secretId, SecretKey: options.secretKey,
    Protocol: 'https:', Timeout: 2_000, AutoSwitchHost: false, KeepAlive: false });
  sdk.on('before-send', (request: { url: string }) => {
    const url = new URL(request.url);
    request.url = `http://127.0.0.1:${address.port}${url.pathname}${url.search}`;
  });
  const store = new CosArtifactStore(options, sdk);
  const ref = await store.put(input(Buffer.from([0, 255, 13, 10])));
  const fetched = await store.fetch(ref.uri);
  assert.deepEqual(fetched.ref, ref);
  assert.equal(objects.size, 2);
  assert.ok(requests.every(request => request.authorization?.includes('q-signature=')));
  const url = new URL(fetched.url);
  assert.equal(url.hostname, `${options.bucket}.cos.${options.region}.myqcloud.com`);
  assert.equal(url.protocol, 'https:');
  assert.ok(url.searchParams.get('q-signature'));
  const [start, end] = url.searchParams.get('q-sign-time')!.split(';').map(Number);
  assert.equal(end! - start!, 3_600);

  const source = new ReadableStream<Uint8Array>({ start(controller) {
    controller.enqueue(Buffer.from('partial publication'));
    setTimeout(() => controller.error(new DOMException('Canceled publication', 'AbortError')), 20);
  } });
  await assert.rejects(store.put({ ...input(), body: source }), { name: 'AbortError' });
  assert.equal(objects.size, 2, 'failed source cannot commit an uploaded object or metadata');
  assert.equal(requests.filter(request => request.method === 'PUT' && request.key.includes('/.metadata/')).length, 1);
});
