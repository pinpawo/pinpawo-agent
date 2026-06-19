import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { FileStudioDueRunStore } from './fileDueRunStore';

async function mkTempDir(prefix: string): Promise<string> {
  return await fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

test('file-backed store restores persisted due-run rows and applies workdir claim filter', async () => {
  const root = await mkTempDir('studio-due-run-file-');
  const storePath = path.join(root, 'studio-due-runs.json');
  let firstNowIndex = 0;
  const nowSequence = [
    '2026-06-19T00:00:00.000Z',
    '2026-06-19T00:00:01.000Z',
    '2026-06-19T00:00:02.000Z',
  ];
  const seqNow = () => nowSequence[firstNowIndex++] ?? '2026-06-19T00:00:02.000Z';

  const first = new FileStudioDueRunStore({
    filePath: storePath,
    now: seqNow,
  });
  const row = first.submit({
    runId: 'run-file-1',
    conversationId: 'conv-1',
    workdir: '/tmp/wd-a',
    userRequest: 'one',
  });
  const rowB = first.submit({
    runId: 'run-file-2',
    conversationId: 'conv-2',
    workdir: '/tmp/wd-b',
    userRequest: 'two',
  });
  const claim = first.claim('owner-1', { workdir: '/tmp/wd-a' });
  assert.ok(claim);
  assert.equal(claim?.run.identity.idempotencyKey, row.identity.idempotencyKey);

  // Re-open from disk, and assert claim filtering on restored state works.
  const second = new FileStudioDueRunStore({ filePath: storePath });
  const same = second.getByIdempotencyKey(row.identity.idempotencyKey);
  assert.equal(same?.status, 'claimed');
  assert.equal(second.claim('owner-2', { workdir: '/tmp/wd-other' }), null);
  assert.equal(second.claim('owner-2', { workdir: '/tmp/wd-a' }), null);

  const sameDir = second.claim('owner-2', { workdir: '/tmp/wd-b' });
  assert.equal(sameDir?.run.status, 'claimed');
  assert.equal(sameDir?.run.identity.idempotencyKey, rowB.identity.idempotencyKey);
});

test('file-backed store respects retryDelayMs across reopened instances', async () => {
  const root = await mkTempDir('studio-due-run-file-retry-');
  const storePath = path.join(root, 'studio-due-runs.json');

  const first = new FileStudioDueRunStore({
    filePath: storePath,
    now: () => '2026-06-19T00:00:00.000Z',
    retryDelayMs: 30000,
  });
  first.submit({
    runId: 'run-file-retry',
    conversationId: 'conv-retry',
    workdir: '/tmp/wd-c',
    userRequest: 'retry case',
  });
  const claim = first.claim('owner-1');
  assert.ok(claim);
  const running = first.start({ run: claim.run, token: claim.token });
  const failed = first.fail({ run: running, token: claim.token }, { errorCode: 'E_TEMP' });
  assert.equal(failed.status, 'failed');
  assert.equal(failed.ownerUserId, 'owner-1');

  const early = new FileStudioDueRunStore({
    filePath: storePath,
    now: () => '2026-06-19T00:00:10.000Z',
  });
  assert.equal(early.claim('owner-2'), null);
  assert.throws(
    () => early.retry({ run: failed, token: claim.token }),
    /not ready for retry/,
  );

  const ready = new FileStudioDueRunStore({
    filePath: storePath,
    now: () => '2026-06-19T00:00:40.000Z',
  });
  const retriable = ready.retry({ run: failed, token: claim.token });
  assert.equal(retriable.status, 'pending');
  const next = ready.claim('owner-2');
  assert.equal(next?.run.status, 'claimed');
  assert.equal(next?.run.attempt, 2);
});
