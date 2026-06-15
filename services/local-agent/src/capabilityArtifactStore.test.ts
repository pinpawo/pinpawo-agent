import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { FileCapabilityArtifactStore } from './capabilityArtifactStore';
import { createCapabilityArtifactToolkit } from './toolkits/capabilityArtifact';

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

test('capability artifact toolkit scopes tools to the current thread', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pinpawo-artifacts-toolkit-'));
  mkdirSync(root, { recursive: true });
  const store = new FileCapabilityArtifactStore(root);
  const toolkit = createCapabilityArtifactToolkit(store);
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
