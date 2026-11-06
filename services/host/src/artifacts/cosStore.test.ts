import assert from 'node:assert/strict';
import test from 'node:test';
import type COS from 'cos-nodejs-sdk-v5';
import { createCosArtifactStore } from './cosStore';

test('COS stores immutable snapshots and metadata, scopes listing, and signs downloads on demand', async () => {
  const objects = new Map<string, Buffer>();
  const signedKeys: string[] = [];
  const listedPrefixes: string[] = [];
  const fake = {
    async putObject(input: COS.PutObjectParams) {
      const chunks: Buffer[] = [];
      if (typeof input.Body === 'string') chunks.push(Buffer.from(input.Body));
      else for await (const chunk of input.Body as unknown as AsyncIterable<Buffer>) chunks.push(Buffer.from(chunk));
      objects.set(input.Key, Buffer.concat(chunks));
      return {};
    },
    async getObject(input: COS.GetObjectParams) {
      const Body = objects.get(input.Key);
      if (!Body) throw Object.assign(new Error('missing'), { code: 'NoSuchKey' });
      return { Body };
    },
    async getBucket(input: COS.GetBucketParams) {
      listedPrefixes.push(input.Prefix!);
      return { Contents: [...objects.keys()].filter(key => key.startsWith(input.Prefix!)).map(Key => ({ Key })), IsTruncated: 'false' };
    },
    getObjectUrl(input: COS.GetObjectUrlParams) {
      assert.equal(input.Expires, 900);
      assert.equal(input.Sign, true);
      signedKeys.push(input.Key);
      return `https://bucket.example/${encodeURIComponent(input.Key)}?signed=true`;
    },
  } as unknown as NonNullable<Parameters<typeof createCosArtifactStore>[1]>;
  const store = createCosArtifactStore({ adapter: 'cos', bucket: 'test-bucket', region: 'test-region',
    workspaceId: 'workspace', prefix: 'published', secretId: 'test-id', secretKey: 'test-key' }, fake);
  const makeBody = (text: string) => new ReadableStream<Uint8Array>({ start(controller) {
    controller.enqueue(new TextEncoder().encode(text)); controller.close();
  } });
  const first = await store.put({ threadId: 'one', name: '报告 #%.txt', mimeType: 'text/plain', body: makeBody('first') });
  const second = await store.put({ threadId: 'two', name: 'report.txt', mimeType: 'text/plain', body: makeBody('second') });
  assert.equal(first.size, 5);
  assert.equal(first.sha256.length, 64);
  assert.deepEqual(await store.list('one'), [first]);
  assert.ok(listedPrefixes.every(prefix => prefix === 'published/.metadata/workspace/one/'));
  assert.equal(signedKeys.length, 0);
  const download = await store.fetch(second.uri);
  assert.ok('url' in download);
  assert.ok(download.url.startsWith('https://bucket.example/'));
  assert.equal(download.ref.uri, second.uri);
  assert.equal(signedKeys.length, 1);
  assert.ok(signedKeys[0]!.startsWith('published/workspace/two/'));
  assert.ok(!JSON.stringify([...objects.values()].map(value => value.toString())).includes('signed=true'));
  await assert.rejects(store.fetch('artifact://workspace/one/missing/no.txt'), /missing/);
});
