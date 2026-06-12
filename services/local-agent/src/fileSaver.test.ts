import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { emptyCheckpoint, type Checkpoint, type CheckpointMetadata } from '@langchain/langgraph-checkpoint';
import { FileSaver } from './fileSaver';

function makeCheckpoint(): Checkpoint {
  return emptyCheckpoint();
}

function metadata(step: number): CheckpointMetadata {
  return { source: 'loop', step, parents: {} };
}

function configFor(threadId: string) {
  return { configurable: { thread_id: threadId, checkpoint_ns: '' } };
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

test('FileSaver keeps the most recent checkpoints and prunes older ones', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'filesaver-'));
  try {
    const saver = new FileSaver(join(dir, 'cp.json'), 1_000_000, 3);
    const ids: string[] = [];
    for (let i = 0; i < 6; i++) {
      const result = await saver.put(configFor('thread-b'), makeCheckpoint(), metadata(i));
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
