import assert from 'node:assert/strict';
import test from 'node:test';
import {
  applyStudioDueRunEvent,
  buildStudioDueRunRecord,
  canRetry,
  isTerminalStudioDueRunStatus,
} from './dueRunContract';

test('buildStudioDueRunRecord derives default and explicit conversation identity', () => {
  const row = buildStudioDueRunRecord({
    runId: 'run-1',
    workdir: '/tmp/workdir',
    ownerUserId: 'user-1',
    userRequest: 'do it',
    now: '2026-06-19T00:00:00.000Z',
  });

  assert.equal(row.runId, 'run-1');
  assert.equal(row.conversationId, 'run-1');
  assert.equal(row.identity.conversationId, 'run-1');
  assert.equal(row.identity.idempotencyKey, 'studio:run-1:run:run-1');
  assert.equal(row.status, 'pending');
  assert.equal(row.attempt, 0);

  const rowWithConversation = buildStudioDueRunRecord({
    runId: 'run-2',
    conversationId: 'conversation-2',
    workdir: '/tmp/workdir',
    userRequest: 'do it',
    now: '2026-06-19T00:00:00.000Z',
  });

  assert.equal(rowWithConversation.conversationId, 'conversation-2');
  assert.equal(rowWithConversation.identity.conversationId, 'conversation-2');
  assert.equal(rowWithConversation.identity.idempotencyKey, 'studio:conversation-2:run:run-2');
});

test('buildStudioDueRunRecord/cancel transitions follow claim→start→success contract', () => {
  const original = buildStudioDueRunRecord({
    runId: 'run-1',
    workdir: '/tmp/workdir',
    userRequest: 'do it',
    now: '2026-06-19T00:00:00.000Z',
  });
  const claimed = applyStudioDueRunEvent(original, { type: 'claim' }, '2026-06-19T00:00:01.000Z');
  assert.equal(claimed.status, 'claimed');
  assert.equal(claimed.attempt, 1);
  assert.equal(claimed.claimedAt, '2026-06-19T00:00:01.000Z');

  const running = applyStudioDueRunEvent(claimed, { type: 'start' }, '2026-06-19T00:00:02.000Z');
  assert.equal(running.status, 'running');

  const done = applyStudioDueRunEvent(running, {
    type: 'succeed',
    finalDispatchId: 'dispatch-1',
    reply: 'done',
  }, '2026-06-19T00:00:03.000Z');
  assert.equal(done.status, 'success');
  assert.equal(done.finalDispatchId, 'dispatch-1');
  assert.equal(done.reply, 'done');
  assert.equal(done.completedAt, '2026-06-19T00:00:03.000Z');
  assert.equal(isTerminalStudioDueRunStatus(done.status), true);
});

test('failed rows can retry back to pending; retrying preserves identity and adds new claim', () => {
  const claimed = applyStudioDueRunEvent(buildStudioDueRunRecord({
    runId: 'run-3',
    workdir: '/tmp/workdir',
    userRequest: 'do it',
  }), { type: 'claim' }, '2026-06-19T00:00:01.000Z');
  const running = applyStudioDueRunEvent(claimed, { type: 'start' }, '2026-06-19T00:00:02.000Z');
  const broken = applyStudioDueRunEvent(running, {
    type: 'fail',
    errorCode: 'E_TASK',
    errorDetail: 'temporary issue',
  }, '2026-06-19T00:00:03.000Z');

  assert.equal(broken.status, 'failed');
  assert.equal(canRetry(broken), true);

  const retried = applyStudioDueRunEvent(broken, { type: 'retry' }, '2026-06-19T00:00:04.000Z');
  assert.equal(retried.status, 'pending');
  assert.equal(retried.errorCode, undefined);
  assert.equal(retried.errorDetail, undefined);

  const claimedAgain = applyStudioDueRunEvent(retried, { type: 'claim' }, '2026-06-19T00:00:05.000Z');
  assert.equal(claimedAgain.attempt, broken.attempt + 1);
  assert.equal(claimedAgain.claimedAt, '2026-06-19T00:00:05.000Z');
  assert.equal(claimedAgain.status, 'claimed');
});

test('invalid transition throws', () => {
  const row = buildStudioDueRunRecord({
    runId: 'run-4',
    workdir: '/tmp/workdir',
    userRequest: 'do it',
  });

  assert.throws(
    () => applyStudioDueRunEvent(row, { type: 'succeed', finalDispatchId: 'dispatch-1' }),
    /invalid due-run status transition/,
  );
});
