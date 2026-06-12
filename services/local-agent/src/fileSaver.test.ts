import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { emptyCheckpoint, type Checkpoint, type CheckpointMetadata } from '@langchain/langgraph-checkpoint';
import { FileSaver } from './fileSaver';

const EMPTY_JSON_BASE64 = Buffer.from('{}').toString('base64');

function toBase64(u8: Uint8Array) {
  return Buffer.from(u8).toString('base64');
}

function makeCheckpoint(): Checkpoint {
  return emptyCheckpoint();
}

function makeCheckpointWithId(id: string): Checkpoint {
  const checkpoint = emptyCheckpoint();
  checkpoint.id = id;
  return checkpoint;
}

function metadata(step: number): CheckpointMetadata {
  return { source: 'loop', step, parents: {} };
}

function configFor(threadId: string, checkpointNs = '') {
  return { configurable: { thread_id: threadId, checkpoint_ns: checkpointNs } };
}

async function putN(saver: FileSaver, threadId: string, count: number) {
  for (let i = 0; i < count; i++) {
    await saver.put(configFor(threadId), makeCheckpoint(), metadata(i));
  }
}

function countCheckpoints(saver: FileSaver, threadId: string) {
  const namespaces = (saver as unknown as {
    storage: Record<string, Record<string, Record<string, unknown>>>;
  }).storage[threadId] ?? {};
  return Object.values(namespaces)
    .reduce((total, checkpoints) => total + Object.keys(checkpoints).length, 0);
}

function internals(saver: FileSaver) {
  return saver as unknown as {
    dirty: boolean;
    storage: Record<string, Record<string, Record<string, [Uint8Array, Uint8Array, unknown]>>>;
    writes: Record<string, Record<string, [string, string, Uint8Array]>>;
  };
}

function legacyDataFromSaver(saver: FileSaver) {
  const source = internals(saver);
  const storage: Record<string, Record<string, Record<string, [string, string, string | undefined]>>> = {};
  const writes: Record<string, Record<string, [string, string, string]>> = {};

  for (const [threadId, namespaces] of Object.entries(source.storage)) {
    storage[threadId] = {};
    for (const [namespace, checkpoints] of Object.entries(namespaces)) {
      storage[threadId][namespace] = {};
      for (const [checkpointId, tuple] of Object.entries(checkpoints)) {
        storage[threadId][namespace][checkpointId] = [
          toBase64(tuple[0]),
          toBase64(tuple[1]),
          typeof tuple[2] === 'string' ? tuple[2] : undefined,
        ];
      }
    }
  }

  for (const [outerKey, outerWrites] of Object.entries(source.writes)) {
    writes[outerKey] = {};
    for (const [innerKey, tuple] of Object.entries(outerWrites)) {
      writes[outerKey][innerKey] = [tuple[0], tuple[1], toBase64(tuple[2])];
    }
  }

  return { storage, writes };
}

function writeThreadShard(
  dir: string,
  baseName: string,
  threadId: string,
  checkpointIds: string[],
) {
  const bucket = '2026-01-01';
  const storage = Object.fromEntries(
    checkpointIds.map((checkpointId) => [
      checkpointId,
      [EMPTY_JSON_BASE64, EMPTY_JSON_BASE64, undefined],
    ]),
  );
  const file = join(dir, `${baseName}.${bucket}.${encodeURIComponent(threadId)}.json`);
  writeFileSync(file, JSON.stringify({
    threadId,
    bucket,
    storage: { '': storage },
    writes: {},
  }), 'utf-8');
  return file;
}

test('FileSaver caps retained checkpoints per namespace', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'filesaver-'));
  try {
    const saver = new FileSaver(join(dir, 'cp.json'), 1_000_000, 5);
    await putN(saver, 'thread-a', 12);
    assert.equal(countCheckpoints(saver, 'thread-a'), 5);
    saver.dispose();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('FileSaver prunes writes only for checkpoints removed in the same namespace', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'filesaver-'));
  try {
    const saver = new FileSaver(join(dir, 'cp.json'), 1_000_000, 1);
    const nsAFirst = await saver.put(configFor('thread-d', 'ns-a'), makeCheckpointWithId('0001'), metadata(1));
    await saver.putWrites(nsAFirst, [['result', 'old-a']], 'task-a-old');
    const nsBOnly = await saver.put(configFor('thread-d', 'ns-b'), makeCheckpointWithId('0001'), metadata(2));
    await saver.putWrites(nsBOnly, [['result', 'keep-b']], 'task-b');

    await saver.put(configFor('thread-d', 'ns-a'), makeCheckpointWithId('0002'), metadata(3));

    const writeKeys = Object.keys(internals(saver).writes).map((key) => JSON.parse(key) as string[]);
    assert.deepEqual(writeKeys, [['thread-d', 'ns-b', '0001']]);
    saver.dispose();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('FileSaver getTuple without checkpoint id returns latest checkpoint after pruning', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'filesaver-'));
  try {
    const saver = new FileSaver(join(dir, 'cp.json'), 1_000_000, 3);
    const ids: string[] = [];
    for (let i = 0; i < 6; i++) {
      const checkpointId = `000${i}`;
      const result = await saver.put(configFor('thread-e'), makeCheckpointWithId(checkpointId), metadata(i));
      ids.push(result.configurable?.checkpoint_id as string);
    }

    const tuple = await saver.getTuple(configFor('thread-e'));
    assert.equal(tuple?.config.configurable?.checkpoint_id, ids.at(-1));
    assert.equal(tuple?.metadata?.step, 5);
    saver.dispose();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('FileSaver preserves legacy file when any thread fails during migration flush', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'filesaver-'));
  try {
    const legacyFile = join(dir, 'cp.json');
    const seedSaver = new FileSaver(join(dir, 'seed.json'), 1_000_000, 40);
    await seedSaver.put(configFor('bad-thread'), makeCheckpointWithId('bad-checkpoint'), metadata(0));
    writeFileSync(legacyFile, JSON.stringify(legacyDataFromSaver(seedSaver)), 'utf-8');
    internals(seedSaver).dirty = false;
    seedSaver.dispose();

    const saver = new FileSaver(legacyFile, 1_000_000, 40);
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    internals(saver).storage['bad-thread']['']['bad-checkpoint'][2] = circular;

    await saver.put(configFor('small-thread'), makeCheckpoint(), metadata(1));

    const originalError = console.error;
    console.error = () => undefined;
    try {
      saver.flush();
    } finally {
      console.error = originalError;
    }

    assert.equal(existsSync(legacyFile), true);
    internals(saver).dirty = false;
    saver.dispose();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('FileSaver prunes loaded shard files and rewrites trimmed checkpoints', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'filesaver-'));
  try {
    const checkpointIds = ['0001', '0002', '0003', '0004', '0005'];
    const shardFile = writeThreadShard(dir, 'cp', 'thread-f', checkpointIds);

    const saver = new FileSaver(join(dir, 'cp.json'), 1_000_000, 2);
    assert.equal(countCheckpoints(saver, 'thread-f'), 2);
    saver.flush();

    const data = JSON.parse(readFileSync(shardFile, 'utf-8')) as {
      storage: Record<string, Record<string, unknown>>;
    };
    assert.deepEqual(Object.keys(data.storage['']), ['0004', '0005']);
    saver.dispose();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('FileSaver keeps the most recent checkpoints and prunes older ones', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'filesaver-'));
  try {
    const saver = new FileSaver(join(dir, 'cp.json'), 1_000_000, 3);
    const ids: string[] = [];
    for (let i = 0; i < 6; i++) {
      const checkpointId = `000${i}`;
      const result = await saver.put(configFor('thread-b'), makeCheckpointWithId(checkpointId), metadata(i));
      ids.push(result.configurable?.checkpoint_id as string);
    }
    const namespaces = (saver as unknown as {
      storage: Record<string, Record<string, Record<string, unknown>>>;
    }).storage['thread-b'];
    const retained = Object.keys(namespaces['']);
    assert.deepEqual(retained, ids.slice(-3));
    saver.dispose();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('FileSaver does not prune when under the cap', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'filesaver-'));
  try {
    const saver = new FileSaver(join(dir, 'cp.json'), 1_000_000, 40);
    await putN(saver, 'thread-c', 10);
    assert.equal(countCheckpoints(saver, 'thread-c'), 10);
    saver.dispose();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
