import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { defaultCapabilityArtifactRoot, FileCapabilityArtifactStore } from './capabilityArtifactStore';

test('defaultCapabilityArtifactRoot is scoped under the agent workdir', () => {
  assert.equal(
    defaultCapabilityArtifactRoot('/tmp/pinpawo-workdir'),
    '/tmp/pinpawo-workdir/.pinpawo/capability-artifacts',
  );
});

test('FileCapabilityArtifactStore writes, lists, and reads text artifacts', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pinpawo-artifacts-'));
  const store = new FileCapabilityArtifactStore(root);

  const ref = await store.writeArtifact({
    threadId: 'thread-1',
    capabilityId: 'explore',
    delegationId: 'delegation-1',
    runId: 'run-1',
    artifact: {
      kind: 'report',
      mimeType: 'text/markdown',
      title: 'Explore report',
      preview: 'confirmed facts',
      content: '# Explore report\n\nconfirmed facts',
      metadata: { sourceCount: 2 },
    },
  });

  assert.equal(ref.threadId, 'thread-1');
  assert.equal(ref.capabilityId, 'explore');
  assert.equal(ref.kind, 'report');
  assert.match(ref.uri, /^capability-artifact:\/\/thread\/thread-1\/delegation\/delegation-1\/artifact\//);

  const listed = await store.listArtifacts({ threadId: 'thread-1', kind: 'report' });
  assert.equal(listed.length, 1);
  assert.equal(listed[0]?.id, ref.id);

  const read = await store.readArtifact({ uri: ref.uri });
  assert.equal(read.ref.id, ref.id);
  assert.equal(read.content, '# Explore report\n\nconfirmed facts');
});

test('FileCapabilityArtifactStore is idempotent for retried writes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pinpawo-artifacts-idempotent-'));
  const store = new FileCapabilityArtifactStore(root);
  const input = {
    threadId: 'thread-1',
    capabilityId: 'explore',
    delegationId: 'delegation-1',
    runId: 'run-1',
    artifact: {
      kind: 'result' as const,
      mimeType: 'application/json',
      content: { ok: true },
    },
  };

  const first = await store.writeArtifact(input);
  const second = await store.writeArtifact(input);

  assert.equal(second.id, first.id);
  assert.equal((await store.listArtifacts({ threadId: 'thread-1' })).length, 1);
});

test('FileCapabilityArtifactStore writes inline binary content and does not expose it as text', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pinpawo-artifacts-binary-'));
  const store = new FileCapabilityArtifactStore(root);

  const ref = await store.writeArtifact({
    threadId: 'thread-1',
    capabilityId: 'image',
    delegationId: 'delegation-1',
    runId: 'run-1',
    artifact: {
      kind: 'image',
      mimeType: 'image/png',
      content: Buffer.from([0x89, 0x50, 0x4e, 0x47]),
      preview: 'generated image',
    },
  });

  assert.equal(ref.sizeBytes, 4);
  assert.ok(ref.sha256);
  const read = await store.readArtifact({ uri: ref.uri });
  assert.equal(read.ref.id, ref.id);
  assert.equal(read.content, null);
  assert.match(await store.getDownloadUri(ref.uri), /^file:\/\//);
});

test('FileCapabilityArtifactStore stores externalUri refs without copying bytes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pinpawo-artifacts-external-'));
  const store = new FileCapabilityArtifactStore(root);

  const ref = await store.writeArtifact({
    threadId: 'thread-1',
    capabilityId: 'image',
    delegationId: 'delegation-1',
    runId: 'run-1',
    artifact: {
      kind: 'image',
      mimeType: 'image/png',
      externalUri: 'https://cdn.example.com/generated.png',
      preview: 'generated image',
    },
  });

  assert.equal(ref.sizeBytes, 0);
  assert.equal(ref.sha256, undefined);
  assert.equal(ref.externalUri, 'https://cdn.example.com/generated.png');
  const read = await store.readArtifact({ uri: ref.uri });
  assert.equal(read.ref.externalUri, 'https://cdn.example.com/generated.png');
  assert.equal(read.content, null);
  assert.equal(await store.getDownloadUri(ref.uri), 'https://cdn.example.com/generated.png');
});

test('FileCapabilityArtifactStore reads text maxBytes without splitting UTF-8 characters', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pinpawo-artifacts-utf8-'));
  const store = new FileCapabilityArtifactStore(root);
  const ref = await store.writeArtifact({
    threadId: 'thread-1',
    capabilityId: 'explore',
    delegationId: 'delegation-1',
    runId: 'run-1',
    artifact: {
      kind: 'report',
      mimeType: 'text/plain',
      content: '你好世界',
    },
  });

  const read = await store.readArtifact({ uri: ref.uri, maxBytes: 5 });

  assert.equal(read.content, '你');
  assert.equal(read.content?.includes('\uFFFD'), false);
});

test('FileCapabilityArtifactStore deletes all artifacts for a thread', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pinpawo-artifacts-delete-'));
  const store = new FileCapabilityArtifactStore(root);
  await store.writeArtifact({
    threadId: 'thread-1',
    capabilityId: 'explore',
    delegationId: 'delegation-1',
    runId: 'run-1',
    artifact: {
      kind: 'report',
      mimeType: 'text/plain',
      content: 'content',
    },
  });

  assert.equal((await store.listArtifacts({ threadId: 'thread-1' })).length, 1);
  await store.deleteThreadArtifacts('thread-1');

  assert.equal((await store.listArtifacts({ threadId: 'thread-1' })).length, 0);
  assert.equal(existsSync(join(root, 'threads', 'thread-1')), false);
});
