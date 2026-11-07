import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { isJsonObject, parseDeliverables, type ArtifactRef, type Deliverable } from '@pinpawo/agent-contracts';
import type { BaseMessage } from '@langchain/core/messages';
import type { ArtifactReader } from '../artifacts/http';
import { readArtifactSource } from '../artifacts/files';
import { createLocalArtifactStore } from '../artifacts/localStore';
import { createArtifactChatHumanMessage } from './artifactImageInput';
import { ImageAdmissionError, MAX_LOCAL_IMAGE_BYTES } from './attachmentAdmission';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jw1sAAAAASUVORK5CYII=', 'base64');
const uri = 'artifact://workspace/session/image/pixel.png';
const signedUrl = 'https://bucket.example/pixel.png?signature=private-test-signature';
const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const ref = (bytes = png, overrides: Partial<ArtifactRef> = {}): ArtifactRef => ({
  uri, name: 'pixel.png', mimeType: 'image/png', size: bytes.length, sha256: digest(bytes),
  createdAt: '2026-11-05T00:00:00Z', ...overrides,
});
const stream = (bytes = png) => new ReadableStream<Uint8Array>({ start(controller) {
  controller.enqueue(bytes); controller.close();
} });
const local = (bytes = png, overrides: Partial<ArtifactRef> = {}): ArtifactReader => ({
  fetch: async requested => ({ ref: ref(bytes, { uri: requested, ...overrides }), body: stream(bytes) }),
});
const input = (references: readonly Deliverable[], store: ArtifactReader | undefined, allowImages = true) => (
  createArtifactChatHumanMessage('Original Channel request', references, store, { allowImages })
);
function savedReferences(message: BaseMessage) {
  const metadata = message.additional_kwargs.pinpawo;
  assert.ok(isJsonObject(metadata));
  return parseDeliverables(metadata.artifactReferences);
}
async function fails(operation: Promise<unknown>, code: ImageAdmissionError['code']) {
  await assert.rejects(operation, error => {
    assert.ok(error instanceof ImageAdmissionError);
    assert.equal(error.code, code);
    assert.ok(!error.message.includes(signedUrl));
    assert.ok(!error.message.includes('private-test-signature'));
    return true;
  });
}

test('only structured artifact references are fetched; body links and ordinary URL/file references stay text', async (t) => {
  let fetches = 0;
  t.mock.method(globalThis, 'fetch', async () => { fetches += 1; throw new Error('Unexpected network'); });
  const store: ArtifactReader = { fetch: async () => { fetches += 1; throw new Error('Unexpected store read'); } };
  const body = `Quoted body mentions ${uri}`;
  const bodyOnly = await createArtifactChatHumanMessage(body, [], store, { allowImages: false });
  assert.equal(bodyOnly.text, body);
  const references = [{ uri: 'https://example.test/image.png' }, { uri: 'file:///private/image.png' }];
  const message = await createArtifactChatHumanMessage(body, references, store, { allowImages: false });
  assert.equal(fetches, 0);
  assert.equal(message.contentBlocks[0]?.type, 'text');
  assert.equal(message.contentBlocks[0]?.type === 'text' ? message.contentBlocks[0].text : null, body);
  assert.equal(message.contentBlocks.some(block => block.type === 'image'), false);
  assert.match(message.text, /not loaded as images/);
  assert.deepEqual(savedReferences(message), references);
});

test('a published PNG becomes an existing standard image block and durable references retain the original request', async () => {
  const references = [{ uri, title: 'Pixel' }];
  const message = await input(references, local());
  const image = message.contentBlocks.find(block => block.type === 'image');
  assert.equal(image?.mimeType, 'image/png');
  assert.equal(image?.data, png.toString('base64'));
  assert.equal(message.contentBlocks[0]?.type === 'text' ? message.contentBlocks[0].text : null, 'Original Channel request');
  assert.deepEqual(savedReferences(message), references);
  references[0]!.title = 'Changed caller';
  assert.equal(savedReferences(message)[0]!.title, 'Pixel');
});

test('Agent-published WebP files reach another workspace as image input without bypassing admission', async () => {
  const root = await mkdtemp(join(tmpdir(), 'artifact-webp-input-'));
  const webp = Buffer.from('UklGRhwAAABXRUJQVlA4TA8AAAAvAAAAAAcQ/Y/+ByKi/wEA', 'base64');
  const publisher = createLocalArtifactStore({ workspacesDir: root, workspaceId: 'publisher' });
  const receiver = createLocalArtifactStore({ workspacesDir: root, workspaceId: 'receiver' });
  try {
    for (const name of ['pixel.webp', 'pixel.WEBP']) {
      await writeFile(join(root, name), webp);
      const published = await publisher.put({
        ...await readArtifactSource({ path: name, workdir: root }), threadId: 'source-session',
      });
      assert.equal(published.mimeType, 'image/webp');
      assert.equal(published.sha256, digest(webp));
      const references = [{ uri: published.uri, title: name }];
      const message = await input(references, receiver);
      const image = message.contentBlocks.find(block => block.type === 'image');
      assert.equal(image?.mimeType, 'image/webp');
      assert.equal(image?.data, webp.toString('base64'));
      assert.deepEqual(savedReferences(message), references);
      await fails(input(references, receiver, false), 'image_model_unsupported');
    }
    await writeFile(join(root, 'invalid.webp'), 'not an image');
    const invalid = await publisher.put({
      ...await readArtifactSource({ path: 'invalid.webp', workdir: root }), threadId: 'source-session',
    });
    await fails(input([{ uri: invalid.uri }], receiver), 'image_invalid');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('non-image artifacts stay reference-only and cancel their unconsumed body', async () => {
  let cancelled = false;
  const message = await input([{ uri }], { fetch: async () => ({ ref: ref(png, { mimeType: 'application/pdf' }),
    body: new ReadableStream({ cancel() { cancelled = true; } }),
  }) }, false);
  assert.equal(cancelled, true);
  assert.equal(message.contentBlocks.some(block => block.type === 'image'), false);
  assert.match(message.text, /not an image/);
  assert.deepEqual(savedReferences(message), [{ uri }]);
});

test('image failures are explicit and do not expose storage errors or signed URLs', async () => {
  await fails(input([{ uri }], undefined), 'image_invalid');
  await fails(input([{ uri: 'artifact://workspace/../secret' }], local()), 'image_invalid');
  await fails(input([{ uri }], { fetch: async () => { throw new Error(`NoSuchKey at ${signedUrl}`); } }), 'image_invalid');
  await fails(input([{ uri }], local(png, { mimeType: 'image/gif' })), 'image_invalid');
  await fails(input([{ uri }], local(Buffer.from('not an image'))), 'image_invalid');
  await fails(input([{ uri }], local(png, { mimeType: 'image/jpeg' })), 'image_invalid');
  await fails(input([{ uri }], local(png, { size: png.length + 1 })), 'image_invalid');
  await fails(input([{ uri }], local(png, { sha256: '0'.repeat(64) })), 'image_invalid');
  await fails(input([{ uri }], local(png, { uri: 'artifact://another/session/image/pixel.png' })), 'image_invalid');
});

test('the same model and count constraints apply and refused streams are cancelled', async () => {
  let cancelled = 0;
  await fails(input([{ uri }], { fetch: async () => ({ ref: ref(), body: new ReadableStream({
    cancel() { cancelled += 1; },
  }) }) }, false), 'image_model_unsupported');
  assert.equal(cancelled, 1);
  const refs = Array.from({ length: 5 }, (_, index) => ({ uri: `${uri}-${index}` }));
  const store: ArtifactReader = { fetch: async requested => ({ ref: ref(png, { uri: requested }),
    body: requested === refs.at(-1)!.uri
      ? new ReadableStream({ cancel() { cancelled += 1; } }) : stream(),
  }) };
  await fails(input(refs, store), 'image_count_limit');
  assert.equal(cancelled, 2);
});

test('actual streaming bytes enforce single-image and combined limits despite incorrect metadata', async () => {
  let cancelled = false;
  const large = Buffer.alloc(MAX_LOCAL_IMAGE_BYTES);
  png.copy(large);
  await fails(input([{ uri }], { fetch: async () => ({ ref: ref(), body: new ReadableStream({ start(controller) {
    controller.enqueue(large); controller.enqueue(new Uint8Array(1));
  }, cancel() { cancelled = true; } }) }) }), 'image_size_limit');
  assert.equal(cancelled, true);
  const sevenMiB = Buffer.alloc(7 * 1024 * 1024);
  png.copy(sevenMiB);
  const refs = [0, 1, 2].map(index => ({ uri: `${uri}-${index}` }));
  const store: ArtifactReader = { fetch: async requested => ({
    ref: ref(sevenMiB, { uri: requested, ...(requested === refs[2]!.uri ? { size: 1 } : {}) }),
    body: stream(sevenMiB),
  }) };
  await fails(input(refs, store), 'image_total_size_limit');
});

test('signed storage URLs are fetched only inside Host and never enter the model message or errors', async (t) => {
  const store: ArtifactReader = { fetch: async () => ({ ref: ref(), url: signedUrl, expiresAt: '2026-11-05T00:15:00Z' }) };
  t.mock.method(globalThis, 'fetch', async (url: string, options?: RequestInit) => {
    assert.equal(url, signedUrl);
    assert.equal(options?.headers, undefined);
    return new Response(new Uint8Array(png));
  });
  const message = await input([{ uri }], store);
  assert.ok(!JSON.stringify(message).includes('private-test-signature'));
  assert.ok(!JSON.stringify(message).includes(signedUrl));
  t.mock.method(globalThis, 'fetch', async () => { throw new Error(`Network failed for ${signedUrl}`); });
  await fails(input([{ uri }], store), 'image_invalid');
});

test('aborting an artifact body read cancels the source and fails the turn', async () => {
  const controller = new AbortController();
  let reading!: () => void;
  const started = new Promise<void>(resolve => { reading = resolve; });
  let cancelled = false;
  const store: ArtifactReader = { fetch: async () => ({ ref: ref(), body: new ReadableStream({
    pull() { reading(); }, cancel() { cancelled = true; },
  }) }) };
  const pending = createArtifactChatHumanMessage('request', [{ uri }], store, { allowImages: true, signal: controller.signal });
  const rejected = assert.rejects(pending, { name: 'AbortError' });
  await started;
  controller.abort();
  await rejected;
  assert.equal(cancelled, true);
});
