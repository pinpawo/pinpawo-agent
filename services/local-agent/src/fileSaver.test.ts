import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { Checkpoint } from '@langchain/langgraph-checkpoint';
import { FileSaver } from './fileSaver';

function createTempDir(t: TestContext) {
  const root = mkdtempSync(resolve(tmpdir(), 'pinpawo-file-saver-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

function checkpoint(id: string, values: Record<string, unknown>): Checkpoint {
  return {
    v: 4,
    id,
    ts: new Date().toISOString(),
    channel_values: values,
    channel_versions: Object.fromEntries(Object.keys(values).map((key) => [key, id])),
    versions_seen: {},
  };
}

function countObjectFiles(root: string) {
  const objectsDir = join(root, 'checkpoints', 'objects');
  let count = 0;
  for (const prefix of readdirSync(objectsDir)) {
    count += readdirSync(join(objectsDir, prefix)).length;
  }
  return count;
}

function readManifest(root: string, checkpointId: string) {
  const path = join(root, 'checkpoints', 'threads', 'thread-1', 'manifests', '__root__', `${checkpointId}.json`);
  return JSON.parse(readFileSync(path, 'utf-8')) as {
    channelValueRefs?: Record<string, { kind: 'object'; hash: string } | { kind: 'array'; itemHashes: string[] }>;
  };
}

function writeObject(root: string, value: unknown) {
  const bytes = Buffer.from(JSON.stringify(value), 'utf-8');
  const hash = createHash('sha256').update(bytes).digest('hex');
  const dir = join(root, 'checkpoints', 'objects', hash.slice(0, 2));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, hash.slice(2)), bytes);
  return hash;
}

test('FileSaver writes content-addressed checkpoint layout and restores latest tuple', async (t) => {
  const root = createTempDir(t);
  const filePath = join(root, 'checkpoints.json');
  const saver = new FileSaver(filePath);

  const config = { configurable: { thread_id: 'thread-1' } };
  const first = await saver.put(config, checkpoint('cp-1', {
    messages: [{ role: 'human', content: 'same channel value' }],
  }), { source: 'loop', step: 1, parents: {} });
  await saver.put(first, checkpoint('cp-2', {
    messages: [{ role: 'human', content: 'same channel value' }],
  }), { source: 'loop', step: 2, parents: {} });

  assert.equal(existsSync(join(root, 'checkpoints', 'objects')), true);
  assert.equal(readFileSync(join(root, 'checkpoints', 'threads', 'thread-1', 'refs', '__root__'), 'utf-8'), 'cp-2');
  const cp1Messages = readManifest(root, 'cp-1').channelValueRefs?.messages;
  const cp2Messages = readManifest(root, 'cp-2').channelValueRefs?.messages;
  assert.equal(cp1Messages?.kind, 'array');
  assert.equal(cp2Messages?.kind, 'array');
  assert.equal(cp1Messages?.kind === 'array' ? cp1Messages.itemHashes[0] : null, cp2Messages?.kind === 'array' ? cp2Messages.itemHashes[0] : null);
  assert.ok(countObjectFiles(root) < 6, 'shared channel value should avoid writing one object per full checkpoint');

  const restored = new FileSaver(filePath);
  const tuple = await restored.getTuple(config);
  assert.equal(tuple?.checkpoint.id, 'cp-2');
  assert.deepEqual(tuple?.checkpoint.channel_values.messages, [{ role: 'human', content: 'same channel value' }]);
  assert.equal(restored.loadedThreadCount, 1);
});

test('FileSaver stores message arrays as per-message objects and shares growing prefixes', async (t) => {
  const root = createTempDir(t);
  const filePath = join(root, 'checkpoints.json');
  const saver = new FileSaver(filePath);

  const firstMessage = { role: 'human', content: 'same first message' };
  const config = { configurable: { thread_id: 'thread-1' } };
  const first = await saver.put(config, checkpoint('cp-1', {
    messages: [firstMessage],
  }), { source: 'loop', step: 1, parents: {} });
  await saver.put(first, checkpoint('cp-2', {
    messages: [firstMessage, { role: 'ai', content: 'new second message' }],
  }), { source: 'loop', step: 2, parents: {} });

  const cp1Messages = readManifest(root, 'cp-1').channelValueRefs?.messages;
  const cp2Messages = readManifest(root, 'cp-2').channelValueRefs?.messages;

  assert.equal(cp1Messages?.kind, 'array');
  assert.equal(cp2Messages?.kind, 'array');
  assert.deepEqual(cp1Messages?.kind === 'array' ? cp1Messages.itemHashes.length : null, 1);
  assert.deepEqual(cp2Messages?.kind === 'array' ? cp2Messages.itemHashes.length : null, 2);
  assert.equal(cp1Messages?.kind === 'array' ? cp1Messages.itemHashes[0] : null, cp2Messages?.kind === 'array' ? cp2Messages.itemHashes[0] : null);

  const restored = new FileSaver(filePath);
  const tuple = await restored.getTuple(config);
  assert.deepEqual(tuple?.checkpoint.channel_values.messages, [
    firstMessage,
    { role: 'ai', content: 'new second message' },
  ]);
});

test('FileSaver persists pending writes beside checkpoint manifests', async (t) => {
  const root = createTempDir(t);
  const filePath = join(root, 'checkpoints.json');
  const saver = new FileSaver(filePath);

  const config = await saver.put({ configurable: { thread_id: 'thread-1' } }, checkpoint('cp-1', {
    messages: [],
  }), { source: 'loop', step: 1, parents: {} });
  await saver.putWrites(config, [['messages', { role: 'ai', content: 'pending' }]], 'task-1');

  assert.equal(existsSync(join(root, 'checkpoints', 'threads', 'thread-1', 'writes', '__root__', 'cp-1.json')), true);

  const restored = new FileSaver(filePath);
  const tuple = await restored.getTuple(config);
  assert.deepEqual(tuple?.pendingWrites, [['task-1', 'messages', { role: 'ai', content: 'pending' }]]);
});

test('FileSaver serializes concurrent putWrites for the same checkpoint', async (t) => {
  const root = createTempDir(t);
  const filePath = join(root, 'checkpoints.json');
  const saver = new FileSaver(filePath);

  const config = await saver.put({ configurable: { thread_id: 'thread-1' } }, checkpoint('cp-1', {
    messages: [],
  }), { source: 'loop', step: 1, parents: {} });

  // LangGraph fans these out concurrently for sibling tasks on one checkpoint.
  await Promise.all([
    saver.putWrites(config, [['channel-a', { content: 'a' }]], 'task-a'),
    saver.putWrites(config, [['channel-b', { content: 'b' }]], 'task-b'),
  ]);

  const restored = new FileSaver(filePath);
  const tuple = await restored.getTuple(config);
  const channels = (tuple?.pendingWrites ?? []).map((write) => write[1]).sort();
  assert.deepEqual(channels, ['channel-a', 'channel-b']);
});

test('FileSaver leaves legacy monolith and shard data untouched without restoring them', async (t) => {
  const root = createTempDir(t);
  const filePath = join(root, 'checkpoints.json');
  const cp = checkpoint('cp-legacy', { messages: ['legacy'] });
  const metadata = { source: 'loop', step: 1, parents: {} };
  writeFileSync(filePath, JSON.stringify({
    storage: {
      'thread-legacy': {
        '': {
          'cp-legacy': [
            Buffer.from(JSON.stringify(cp), 'utf-8').toString('base64'),
            Buffer.from(JSON.stringify(metadata), 'utf-8').toString('base64'),
            undefined,
          ],
        },
      },
    },
    writes: {},
  }), 'utf-8');
  const shardPath = join(root, 'checkpoints.shard.json');
  writeFileSync(shardPath, JSON.stringify({
    threadId: 'thread-shard',
    bucket: 'shard',
    storage: {
      '': {
        'cp-shard': [
          Buffer.from(
            JSON.stringify(checkpoint('cp-shard', { messages: ['legacy shard'] })),
            'utf-8',
          ).toString('base64'),
          Buffer.from(JSON.stringify(metadata), 'utf-8').toString('base64'),
          undefined,
        ],
      },
    },
    writes: {},
  }), 'utf-8');

  const saver = new FileSaver(filePath);
  const tuple = await saver.getTuple({ configurable: { thread_id: 'thread-legacy' } });

  assert.equal(tuple, undefined);
  assert.equal(await saver.getTuple({ configurable: { thread_id: 'thread-shard' } }), undefined);
  assert.equal(existsSync(join(root, 'checkpoints')), false);
  assert.equal(existsSync(filePath), true);
  assert.equal(existsSync(shardPath), true);
});

test('FileSaver rejects content-addressed manifests without channelValueRefs', (t) => {
  const root = createTempDir(t);
  const filePath = join(root, 'checkpoints.json');
  const cp = checkpoint('cp-old-cas', {});
  const metadata = { source: 'loop', step: 1, parents: {} };
  const shellHash = writeObject(root, cp);
  const metadataHash = writeObject(root, metadata);
  const messagesHash = writeObject(root, [{ role: 'human', content: 'old layout' }]);
  const manifestDir = join(root, 'checkpoints', 'threads', 'thread-1', 'manifests', '__root__');
  const refDir = join(root, 'checkpoints', 'threads', 'thread-1', 'refs');
  mkdirSync(manifestDir, { recursive: true });
  mkdirSync(refDir, { recursive: true });
  writeFileSync(join(manifestDir, 'cp-old-cas.json'), JSON.stringify({
    version: 1,
    threadId: 'thread-1',
    namespace: '',
    checkpointId: 'cp-old-cas',
    checkpointShellHash: shellHash,
    metadataHash,
    channelValueHashes: { messages: messagesHash },
  }), 'utf-8');
  writeFileSync(join(refDir, '__root__'), 'cp-old-cas', 'utf-8');

  assert.throws(
    () => new FileSaver(filePath),
    /checkpoint manifest uses an unsupported format/,
  );
  assert.equal(existsSync(join(root, 'checkpoints', 'objects', shellHash.slice(0, 2), shellHash.slice(2))), true);
  assert.equal(existsSync(join(root, 'checkpoints', 'objects', messagesHash.slice(0, 2), messagesHash.slice(2))), true);
});

test('FileSaver rejects checkpoints older than v4', async (t) => {
  const root = createTempDir(t);
  const saver = new FileSaver(join(root, 'checkpoints.json'));
  const oldCheckpoint = { ...checkpoint('cp-v3', { messages: [] }), v: 3 };

  await assert.rejects(
    () => saver.put(
      { configurable: { thread_id: 'thread-1' } },
      oldCheckpoint,
      { source: 'loop', step: 1, parents: {} },
    ),
    /FileSaver requires v4 or newer/,
  );
});

test('FileSaver rejects stored checkpoints older than v4', async (t) => {
  const root = createTempDir(t);
  const filePath = join(root, 'checkpoints.json');
  const oldCheckpoint = { ...checkpoint('cp-v3', {}), v: 3 };
  const shellHash = writeObject(root, oldCheckpoint);
  const metadataHash = writeObject(root, { source: 'loop', step: 1, parents: {} });
  const manifestDir = join(root, 'checkpoints', 'threads', 'thread-1', 'manifests', '__root__');
  const refDir = join(root, 'checkpoints', 'threads', 'thread-1', 'refs');
  mkdirSync(manifestDir, { recursive: true });
  mkdirSync(refDir, { recursive: true });
  writeFileSync(join(manifestDir, 'cp-v3.json'), JSON.stringify({
    version: 1,
    threadId: 'thread-1',
    namespace: '',
    checkpointId: 'cp-v3',
    checkpointShellHash: shellHash,
    metadataHash,
    channelValueRefs: {},
  }), 'utf-8');
  writeFileSync(join(refDir, '__root__'), 'cp-v3', 'utf-8');

  const saver = new FileSaver(filePath);
  await assert.rejects(
    () => saver.getTuple({ configurable: { thread_id: 'thread-1' } }),
    /checkpoint cp-v3 uses unsupported version 3/,
  );
});

test('FileSaver lists checkpoint history from manifests', async (t) => {
  const root = createTempDir(t);
  const filePath = join(root, 'checkpoints.json');
  const saver = new FileSaver(filePath);

  const config = { configurable: { thread_id: 'thread-1' } };
  const first = await saver.put(config, checkpoint('cp-1', { messages: ['one'] }), {
    source: 'loop',
    step: 1,
    parents: {},
  });
  await saver.put(first, checkpoint('cp-2', { messages: ['two'] }), {
    source: 'loop',
    step: 2,
    parents: {},
  });

  const restored = new FileSaver(filePath);
  const ids: string[] = [];
  for await (const tuple of restored.list(config)) {
    ids.push(tuple.checkpoint.id);
  }

  assert.deepEqual(ids, ['cp-2', 'cp-1']);
});

test('FileSaver deleteThread removes manifests and garbage collects unreachable objects', async (t) => {
  const root = createTempDir(t);
  const filePath = join(root, 'checkpoints.json');
  const saver = new FileSaver(filePath);

  await saver.put({ configurable: { thread_id: 'thread-1' } }, checkpoint('cp-1', {
    messages: [{ role: 'human', content: 'delete me' }],
  }), { source: 'loop', step: 1, parents: {} });

  assert.ok(countObjectFiles(root) > 0);
  await saver.deleteThread('thread-1');

  assert.equal(existsSync(join(root, 'checkpoints', 'threads', 'thread-1')), false);
  assert.equal(countObjectFiles(root), 0);
  assert.equal(await saver.getTuple({ configurable: { thread_id: 'thread-1' } }), undefined);
});

test('FileSaver GC keeps objects shared by another live thread', async (t) => {
  const root = createTempDir(t);
  const filePath = join(root, 'checkpoints.json');
  const saver = new FileSaver(filePath);

  const sharedMessage = { role: 'human', content: 'shared across threads' };
  await saver.put({ configurable: { thread_id: 'thread-1' } }, checkpoint('cp-1', {
    messages: [sharedMessage],
  }), { source: 'loop', step: 1, parents: {} });
  await saver.put({ configurable: { thread_id: 'thread-2' } }, checkpoint('cp-2', {
    messages: [sharedMessage],
  }), { source: 'loop', step: 1, parents: {} });

  const manifest = readManifest(root, 'cp-1');
  const sharedHash = manifest.channelValueRefs?.messages?.kind === 'array'
    ? manifest.channelValueRefs.messages.itemHashes[0]
    : null;
  assert.ok(sharedHash);

  await saver.deleteThread('thread-1');

  assert.equal(existsSync(join(root, 'checkpoints', 'objects', sharedHash.slice(0, 2), sharedHash.slice(2))), true);
  const restored = new FileSaver(filePath);
  assert.deepEqual(
    (await restored.getTuple({ configurable: { thread_id: 'thread-2' } }))?.checkpoint.channel_values.messages,
    [sharedMessage],
  );
});

test('FileSaver isolates checkpoint namespaces and encodes path segments', async (t) => {
  const root = createTempDir(t);
  const filePath = join(root, 'checkpoints.json');
  const saver = new FileSaver(filePath);

  const rootConfig = await saver.put({
    configurable: { thread_id: 'thread/with/slash' },
  }, checkpoint('cp-root', {
    messages: ['root namespace'],
  }), { source: 'loop', step: 1, parents: {} });
  const childConfig = await saver.put({
    configurable: { thread_id: 'thread/with/slash', checkpoint_ns: 'child/ns' },
  }, checkpoint('cp-child', {
    messages: ['child namespace'],
  }), { source: 'loop', step: 1, parents: {} });

  assert.equal(rootConfig.configurable?.checkpoint_ns, '');
  assert.equal(childConfig.configurable?.checkpoint_ns, 'child/ns');
  assert.equal(existsSync(join(root, 'checkpoints', 'threads', 'thread%2Fwith%2Fslash', 'refs', '__root__')), true);
  assert.equal(existsSync(join(root, 'checkpoints', 'threads', 'thread%2Fwith%2Fslash', 'refs', 'child%2Fns')), true);

  const restored = new FileSaver(filePath);

  assert.deepEqual(
    (await restored.getTuple({ configurable: { thread_id: 'thread/with/slash' } }))?.checkpoint.channel_values.messages,
    ['root namespace'],
  );
  assert.deepEqual(
    (await restored.getTuple({ configurable: { thread_id: 'thread/with/slash', checkpoint_ns: 'child/ns' } }))?.checkpoint.channel_values.messages,
    ['child namespace'],
  );
});
