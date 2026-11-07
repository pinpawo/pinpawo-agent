import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { request as httpRequest, type ClientRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { ArtifactRef } from '@pinpawo/agent-contracts';
import { createChannelPlugin } from '@pinpawo-plugin/channel';
import { createStudioHttpPlugin } from '@pinpawo-plugin/studio-http';
import { createLocalArtifactStore } from '../../../services/host/src/artifacts/localStore';
import { createArtifactChatHumanMessage } from '../../../services/host/src/agent/artifactImageInput';
import { createStudioWithPets } from '../../support/livePets';

const token = 'artifact-upload-integration-token';
const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/octet-stream' };
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jBfcAAAAASUVORK5CYII=', 'base64');

async function waitFor(predicate: () => Promise<boolean>) {
  for (let i = 0; i < 200; i++) {
    if (await predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error('Artifact storage did not settle.');
}

test('HTTP upload persists immutable artifacts, shares deliverables through Channel, and preserves image admission', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'studio-upload-e2e-'));
  const store = createLocalArtifactStore({ workspacesDir: root, workspaceId: 'workspace' });
  const channel = createChannelPlugin();
  const http = createStudioHttpPlugin({ port: 0, authToken: token, artifactStore: store });
  const studio = await createStudioWithPets({ studioId: 'upload', plugins: [channel, http], pets: [],
    storage: { kind: 'sqlite', path: ':memory:' } });
  t.after(async () => { await studio.shutdown(); await rm(root, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${http.address()!.port}`;
  const post = (path: string, body: unknown) => fetch(base + path, { method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const name = '报告 #100%?.png';
  const upload = () => fetch(`${base}/artifacts/upload?name=${encodeURIComponent(name)}`, {
    method: 'POST', headers: { ...headers, 'Content-Type': 'image/png' }, body: png,
  });
  const first = await upload();
  assert.equal(first.status, 201);
  const { artifact } = await first.json() as { artifact: ArtifactRef };
  assert.equal(artifact.name, name);
  assert.equal(artifact.size, png.length);
  assert.equal(artifact.mimeType, 'image/png');
  assert.equal(artifact.sha256, createHash('sha256').update(png).digest('hex'));
  assert.match(artifact.uri, /^artifact:\/\/workspace\/studio-uploads\/[0-9a-f-]+\//);
  const second = await (await upload()).json() as { artifact: ArtifactRef };
  assert.notEqual(second.artifact.uri, artifact.uri, 'the caller cannot overwrite an existing snapshot');
  const download = await fetch(`${base}/agent-session/artifacts?uri=${encodeURIComponent(artifact.uri)}`, { headers });
  assert.equal(download.status, 200);
  assert.equal(download.headers.get('x-content-type-options'), 'nosniff');
  assert.match(download.headers.get('content-disposition')!, /^attachment;/);
  assert.deepEqual(Buffer.from(await download.arrayBuffer()), png);

  const created = await post('/channels', { title: 'Attachments', pets: [] });
  assert.equal(created.status, 201);
  const { channel: { channelId } } = await created.json() as { channel: { channelId: string } };
  const deliverables = [{ uri: artifact.uri, title: name }];
  const posted = await post('/channels/messages', { channelId, body: 'Use this image.', deliverables });
  assert.equal(posted.status, 201);
  const context = await fetch(`${base}/channels/context?channelId=${channelId}`, { headers });
  assert.deepEqual((await context.json() as { messages: Array<{ deliverables: unknown }> }).messages[0]!.deliverables, deliverables);
  const admitted = await createArtifactChatHumanMessage('Use this image.', deliverables, store, { allowImages: true });
  assert.ok(Array.isArray(admitted.content) && admitted.content.some(block => typeof block === 'object' && block.type === 'image'));
  // Upload stores opaque file bytes. Host model admission still checks image signatures.
  const invalid = await fetch(`${base}/artifacts/upload?name=invalid.png`, {
    method: 'POST', headers: { ...headers, 'Content-Type': 'image/png' }, body: 'not an image',
  });
  const badRef = (await invalid.json() as { artifact: ArtifactRef }).artifact;
  await assert.rejects(createArtifactChatHumanMessage('Use this image.', [{ uri: badRef.uri }], store, { allowImages: true }),
    (error: unknown) => (error as { code: string }).code === 'image_invalid');

  const largePng = Buffer.alloc(10 * 1024 * 1024 + 1);
  png.copy(largePng);
  const large = await fetch(`${base}/artifacts/upload?name=large.png`, {
    method: 'POST', headers: { ...headers, 'Content-Type': 'image/png' }, body: largePng,
  });
  assert.equal(large.status, 201, 'opaque attachments retain the 20 MiB upload limit');
  const largeRef = (await large.json() as { artifact: ArtifactRef }).artifact;
  await assert.rejects(createArtifactChatHumanMessage('Use this image.', [{ uri: largeRef.uri }], store, { allowImages: true }),
    (error: unknown) => (error as { code: string }).code === 'image_size_limit');

  const file = await fetch(`${base}/artifacts/upload?name=notes.txt`, { method: 'POST',
    headers: { ...headers, 'Content-Type': 'text/plain' }, body: 'ordinary attachment' });
  assert.equal(file.status, 201);
  const fileRef = (await file.json() as { artifact: ArtifactRef }).artifact;
  const plain = await createArtifactChatHumanMessage('Read this.', [{ uri: fileRef.uri }], store, { allowImages: false });
  assert.ok(JSON.stringify(plain.content).includes('not an image'));
});

test('HTTP streaming overflow, receive timeout, disconnect and shutdown clean pending local artifacts', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'studio-upload-cancel-e2e-'));
  const store = createLocalArtifactStore({ workspacesDir: root, workspaceId: 'workspace' });
  let putAttempts = 0;
  const http = createStudioHttpPlugin({ port: 0, authToken: token, maxBodyBytes: 4, maxUploadBytes: 8,
    uploadTimeoutMs: 250, artifactStore: { ...store, async put(input) { putAttempts++; return store.put(input); } } });
  const studio = await createStudioWithPets({ studioId: 'upload-cancel', plugins: [http], pets: [],
    storage: { kind: 'sqlite', path: ':memory:' } });
  t.after(async () => { await studio.shutdown(); await rm(root, { recursive: true, force: true }); });
  const url = `http://127.0.0.1:${http.address()!.port}/artifacts/upload?name=file.bin`;
  const directory = join(root, 'workspace', 'artifacts', 'studio-uploads');
  const entries = () => readdir(directory).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return []; throw error; });
  const noPartial = async () => { await waitFor(async () => (await entries()).length === 0); assert.deepEqual(await store.list('studio-uploads'), []); };
  const open = () => {
    let request!: ClientRequest;
    const response = new Promise<number>((resolve, reject) => {
      request = httpRequest(url, { method: 'POST', headers }, incoming => {
        incoming.resume(); incoming.on('end', () => resolve(incoming.statusCode!));
      });
      request.on('error', reject);
      request.write('1234');
    });
    return { request, response };
  };
  const overflow = open();
  overflow.request.end('56789');
  assert.equal(await overflow.response, 413, 'chunked uploads use the streaming cap, not the 4-byte JSON cap');
  await noPartial();

  const slow = open();
  assert.equal(await slow.response, 408, 'a pending read fails at the explicit receive deadline');
  slow.request.destroy();
  await noPartial();

  const disconnected = open();
  const disconnectResult = disconnected.response.catch(() => undefined);
  await waitFor(async () => (await entries()).some(name => name.startsWith('.pending-')));
  disconnected.request.destroy();
  await disconnectResult;
  await noPartial();

  const stopping = open();
  const stopResult = stopping.response.catch(() => undefined);
  await waitFor(async () => (await entries()).some(name => name.startsWith('.pending-')));
  await http.stop();
  await stopResult;
  await noPartial();
  assert.equal(putAttempts, 4);
});
