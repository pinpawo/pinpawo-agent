import assert from 'node:assert/strict';
import test from 'node:test';
import { InMemoryStudioDueRunStore } from './dueRunScheduler';

test('submit uses idempotent idempotencyKey and defaults conversation from runId', () => {
  const store = new InMemoryStudioDueRunStore();
  const first = store.submit({
    runId: 'run-1',
    workdir: '/tmp/wd',
    userRequest: 'build page',
  });
  const second = store.submit({
    runId: 'run-1',
    workdir: '/tmp/wd',
    userRequest: 'build page',
  });

  assert.equal(first.runId, second.runId);
  assert.equal(first.identity.conversationId, 'run-1');
  assert.equal(first.identity.idempotencyKey, second.identity.idempotencyKey);
  assert.equal(first.status, 'pending');
  assert.equal(first.attempt, 0);
});

test('claim/start/succeed moves through pending -> claimed -> running -> success', () => {
  const tickSequence = [
    '2026-06-19T00:00:00.000Z',
    '2026-06-19T00:00:01.000Z',
    '2026-06-19T00:00:02.000Z',
    '2026-06-19T00:00:03.000Z',
  ];
  let index = 0;
  const store = new InMemoryStudioDueRunStore({ now: () => tickSequence[index++] ?? '2026-06-19T00:00:10.000Z' });

  store.submit({
    runId: 'run-1',
    conversationId: 'conv-1',
    workdir: '/tmp/wd',
    userRequest: 'do it',
  });

  const claim = store.claim('owner-1');
  assert.ok(claim);
  if (!claim) {
    throw new Error('expected first claim');
  }
  assert.equal(claim.run.status, 'claimed');
  assert.equal(claim.run.ownerUserId, 'owner-1');

  const running = store.start(claim);
  assert.equal(running.status, 'running');

  const done = store.succeed({ run: running, token: claim.token }, {
    finalPetRunId: 'pet-run-1',
    reply: 'ok',
  });
  assert.equal(done.status, 'success');
  assert.equal(done.finalPetRunId, 'pet-run-1');
  assert.equal(done.finalDispatchId, undefined);
  assert.equal(done.reply, 'ok');
  assert.equal(done.completedAt, '2026-06-19T00:00:02.000Z');

  const trace = store.listTrace();
  assert.equal(trace[0]?.finalPetRunId, 'pet-run-1');
});

test('failed rows can retry after failed transition', () => {
  const times = [
    '2026-06-19T00:00:00.000Z',
    '2026-06-19T00:00:01.000Z',
    '2026-06-19T00:00:02.000Z',
    '2026-06-19T00:00:03.000Z',
    '2026-06-19T00:00:04.000Z',
  ];
  let index = 0;
  const store = new InMemoryStudioDueRunStore({
    now: () => times[index++] ?? '2026-06-19T00:01:00.000Z',
  });
  store.submit({
    runId: 'run-2',
    conversationId: 'conv-2',
    workdir: '/tmp/wd',
    userRequest: 'do again',
  });

  const firstClaim = store.claim('owner-2');
  assert.ok(firstClaim);
  if (!firstClaim) {
    throw new Error('expected first claim');
  }
  assert.equal(firstClaim.run.attempt, 1);
  const running = store.start(firstClaim);
  const failed = store.fail({ run: running, token: firstClaim.token }, {
    errorCode: 'E_TEMP',
    errorDetail: 'temporary network',
  });
  assert.equal(failed.status, 'failed');
  assert.equal(failed.errorCode, 'E_TEMP');

  const retriable = store.retry({ run: failed, token: firstClaim.token });
  assert.equal(retriable.status, 'pending');

  const secondClaim = store.claim('owner-3');
  assert.ok(secondClaim);
  assert.equal(secondClaim.run.attempt, 2);
  assert.equal(secondClaim.run.status, 'claimed');
});

test('failed rows wait for retryDelayMs before being claimable', () => {
  const nowSequence = [
    '2026-06-19T00:00:00.000Z',
    '2026-06-19T00:00:01.000Z',
    '2026-06-19T00:00:02.000Z',
    '2026-06-19T00:00:10.000Z',
    '2026-06-19T00:00:20.000Z',
    '2026-06-19T00:00:40.000Z',
  ];
  let index = 0;
  const store = new InMemoryStudioDueRunStore({
    now: () => nowSequence[index++] ?? '2026-06-19T00:00:40.000Z',
    retryDelayMs: 30000,
  });

  store.submit({
    runId: 'run-3',
    conversationId: 'conv-3',
    workdir: '/tmp/wd',
    userRequest: 'needs delay',
  });

  const claim = store.claim('owner-1');
  assert.ok(claim);
  if (!claim) {
    throw new Error('expected first claim');
  }
  const running = store.start(claim);
  const failed = store.fail({ run: running, token: claim.token }, {
    errorCode: 'E_TEMP',
    errorDetail: 'need delay',
  });
  assert.equal(failed.status, 'failed');

  const early = store.claim('owner-2');
  assert.equal(early, null);

  assert.throws(
    () => store.retry({ run: failed, token: claim.token }),
    /not ready for retry/,
  );

  const retriable = store.retry({ run: failed, token: claim.token });
  assert.equal(retriable.status, 'pending');

  const later = store.claim('owner-2');
  assert.ok(later);
  assert.equal(later?.run.status, 'claimed');
  assert.equal(later?.run.attempt, 2);
});
