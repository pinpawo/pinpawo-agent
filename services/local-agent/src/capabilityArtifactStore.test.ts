import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { defaultCapabilityArtifactRoot, FileCapabilityArtifactStore } from './capabilityArtifactStore';
import { createCapabilityArtifactToolkit } from './toolkits/capabilityArtifact';

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
    turnId: 'turn-1',
    marker: {
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

  const listed = store.listArtifacts({ threadId: 'thread-1', kind: 'report' });
  assert.equal(listed.length, 1);
  assert.equal(listed[0]?.id, ref.id);

  const read = store.readArtifact({ uri: ref.uri });
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
    turnId: 'turn-1',
    marker: {
      kind: 'result' as const,
      mimeType: 'application/json',
      content: { ok: true },
    },
  };

  const first = await store.writeArtifact(input);
  const second = await store.writeArtifact(input);

  assert.equal(second.id, first.id);
  assert.equal(store.listArtifacts({ threadId: 'thread-1' }).length, 1);
});

test('FileCapabilityArtifactStore copies sourceUri files and does not expose binary content', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pinpawo-artifacts-source-'));
  const source = join(root, 'source.png');
  writeFileSync(source, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  const store = new FileCapabilityArtifactStore(join(root, 'store'));

  const ref = await store.writeArtifact({
    threadId: 'thread-1',
    capabilityId: 'image',
    delegationId: 'delegation-1',
    turnId: 'turn-1',
    marker: {
      kind: 'image',
      mimeType: 'image/png',
      sourceUri: source,
      preview: 'generated image',
    },
  });

  assert.equal(ref.sizeBytes, 4);
  assert.ok(ref.sha256);
  assert.equal(ref.metadata?.sourceUri, source);
  const read = store.readArtifact({ uri: ref.uri });
  assert.equal(read.ref.id, ref.id);
  assert.equal(read.content, null);
});

test('FileCapabilityArtifactStore reads text maxBytes without splitting UTF-8 characters', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pinpawo-artifacts-utf8-'));
  const store = new FileCapabilityArtifactStore(root);
  const ref = await store.writeArtifact({
    threadId: 'thread-1',
    capabilityId: 'explore',
    delegationId: 'delegation-1',
    turnId: 'turn-1',
    marker: {
      kind: 'report',
      mimeType: 'text/plain',
      content: '你好世界',
    },
  });

  const read = store.readArtifact({ uri: ref.uri, maxBytes: 5 });

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
    turnId: 'turn-1',
    marker: {
      kind: 'report',
      mimeType: 'text/plain',
      content: 'content',
    },
  });

  assert.equal(store.listArtifacts({ threadId: 'thread-1' }).length, 1);
  await store.deleteThreadArtifacts('thread-1');

  assert.equal(store.listArtifacts({ threadId: 'thread-1' }).length, 0);
  assert.equal(existsSync(join(root, 'threads', 'thread-1')), false);
});

test('capability artifact toolkit scopes tools to the current thread', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pinpawo-artifacts-toolkit-'));
  mkdirSync(root, { recursive: true });
  const store = new FileCapabilityArtifactStore(root);
  const toolkit = createCapabilityArtifactToolkit(store);
  const unscopedTools = typeof toolkit.tools === 'function'
    ? await toolkit.tools({
      models: {} as never,
      actor: {
        petId: 'pet-1',
        userId: 'user-1',
        name: '小白',
        personality: 'friendly',
        stage: 'adult',
        species: 'cat',
      },
      messages: [],
    })
    : toolkit.tools ?? [];
  assert.ok(unscopedTools.some((item) => item.name === 'capability_artifact_list'));

  const tools = typeof toolkit.tools === 'function'
      ? await toolkit.tools({
        models: {} as never,
        actor: {
          petId: 'pet-1',
          userId: 'user-1',
          name: '小白',
          personality: 'friendly',
          stage: 'adult',
          species: 'cat',
        },
        messages: [],
        threadId: 'thread-toolkit',
      })
    : toolkit.tools ?? [];
  const write = tools.find((item) => item.name === 'capability_artifact_write');
  const list = tools.find((item) => item.name === 'capability_artifact_list');
  const read = tools.find((item) => item.name === 'capability_artifact_read');

  assert.ok(write);
  assert.ok(list);
  assert.ok(read);

  const writeResult = await write.invoke({
    kind: 'result',
    mimeType: 'application/json',
    title: 'JSON result',
    content: { ok: true },
  });
  const ref = JSON.parse(String(writeResult)) as { uri: string; threadId: string };
  assert.equal(ref.threadId, 'thread-toolkit');

  const listResult = JSON.parse(String(await list.invoke({ kind: 'result' }))) as Array<{ uri: string }>;
  assert.equal(listResult.length, 1);
  assert.equal(listResult[0]?.uri, ref.uri);

  const readResult = JSON.parse(String(await read.invoke({ uri: ref.uri }))) as { content: string };
  assert.equal(readResult.content, '{\n  "ok": true\n}');

  const otherThreadRef = await store.writeArtifact({
    threadId: 'thread-other',
    capabilityId: 'explore',
    delegationId: 'delegation-other',
    turnId: 'turn-other',
    marker: {
      kind: 'report',
      mimeType: 'text/markdown',
      content: 'secret',
    },
  });
  await assert.rejects(
    () => read.invoke({ uri: otherThreadRef.uri }),
    /another thread/,
  );
});
