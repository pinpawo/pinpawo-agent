import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cases } from './cases';
import { score, summarize } from './scorer';
test('Head eval distinguishes work and reply presence, handling, invalidity and provider failure', () => {
  const combined = cases.find(row => row.id === 'combined')!;
  const good = score(combined, { action: 'dispatch', reply: '收到' });
  assert.equal(good.pass, true);
  const wrong = score(combined, { action: 'dispatch', reply: '' });
  assert.equal(wrong.dispatchPass, true); assert.equal(wrong.replyPresencePass, false);
  assert.deepEqual([wrong.valid, wrong.routePass, wrong.statusPass], [true, false, true]);
  const failed = score(combined, undefined, 'provider-error');
  const summary = summarize([{ kind: 'contrast', score: good }, { kind: 'contrast', score: wrong }, { kind: 'contrast', score: failed }]);
  assert.deepEqual(summary.contrast.conditionalDecisionPass, { pass: 1, total: 2 });
  assert.equal(summary.contrast.total, 3); assert.equal(summary.errors, 1);
});
test('Organic cases are acceptance sets, not exact behavior accuracy', () => {
  const organic = cases.find(row => row.kind === 'organic')!;
  assert.equal(score(organic, { action: 'ignore' }).pass, true);
  assert.equal(score(organic, { action: 'direct', reply: '待核查' }).pass, true);
  assert.equal(score(organic, { action: 'ignore', reply: 'Invalid extra reply' }).valid, false);
});
test('Independent additions and unsupported edits are author neutral; follow-up has no mention and grounded prior reply', () => {
  for (const author of ['human', 'pet']) {
    const queued = cases.find(row => row.id === `queue-${author}`)!;
    const unsupportedEdit = cases.find(row => row.id === `unsupported-edit-${author}`)!;
    assert.equal(score(queued, { action: 'dispatch', reply: '' }).pass, true);
    assert.equal(score(unsupportedEdit, { action: 'direct', reply: '无法更改正在执行的任务。' }).pass, true);
    assert.equal(score(unsupportedEdit, { action: 'dispatch', reply: '' }).pass, false);
  }
  const follow = cases.find(row => row.id === 'no-at-followup')!.input;
  assert.deepEqual(follow.message.mentions, []);
  assert.equal(follow.message.replyTo, follow.context.messages[0]!.messageId);
});

test('Peer acknowledgement cannot revive a previous combined human request', () => {
  const testCase = cases.find(row => row.id === 'peer-ack-not-new-request')!;
  assert.equal(testCase.input.message.author.kind, 'pet');
  assert.equal(testCase.input.message.replyTo, testCase.input.context.messages[0]!.messageId);
  assert.equal(score(testCase, { action: 'ignore' }).pass, true);
  for (const decision of [
    { action: 'direct' as const, reply: '收到' },
    { action: 'dispatch' as const, reply: '' },
  ]) assert.equal(score(testCase, decision).pass, false);
});

test('Substantive direct peer question is not satisfied by ignoring every Pet', () => {
  const testCase = cases.find(row => row.id === 'peer-direct-ask')!;
  assert.equal(score(testCase, { action: 'direct', reply: '同比比较去年同期，环比比较上一期。' }).pass, true);
  assert.equal(score(testCase, { action: 'direct', reply: '  ' }).pass, false);
});

test('Execution facts and independently executable work are distinct', () => {
  const progress = cases.find(row => row.id === 'progress-only')!;
  const mixed = cases.find(row => row.id === 'progress-and-addition')!;
  assert.equal(score(progress, { action: 'status' }).pass, true);
  assert.equal(score(progress, { action: 'status', reply: null }).pass, true);
  assert.equal(score(progress, { action: 'status', reply: 'Unchecked claim' }).valid, false);
  assert.equal(score(progress, { action: 'ignore' }).pass, false);
  assert.equal(score(mixed, { action: 'dispatch' }).pass, true);
});

for (const author of ['human', 'pet'] as const) {
  test(`Finished artifact review is new work; a status question or thanks from a ${author} is not`, () => {
    const review = cases.find(row => row.id === `addressed-review-${author}`)!;
    const status = cases.find(row => row.id === `addressed-review-status-${author}`)!;
    const thanks = cases.find(row => row.id === `addressed-thanks-${author}`)!;
    assert.equal(review.input.message.author.kind, author);
    assert.equal(!!review.input.message.externalRef, author === 'pet');
    assert.deepEqual(review.input.message.mentions, status.input.message.mentions);
    assert.equal(review.input.context.messages[0]?.messageId, status.input.context.messages[0]?.messageId);
    assert.equal(score(review, { action: 'dispatch' }).pass, true);
    const observedFailure = score(review, { action: 'status' });
    assert.equal(observedFailure.valid, true);
    assert.equal(observedFailure.pass, false, 'valid structured output alone must not pass the delegation eval');
    assert.equal(score(review, { action: 'direct' }).pass, false);
    assert.equal(score(review, { action: 'ignore' }).pass, false);
    assert.equal(score(status, { action: 'status' }).pass, true);
    assert.equal(score(status, { action: 'dispatch' }).pass, false);
    assert.equal(score(thanks, { action: 'direct' }).pass, true);
    assert.equal(score(thanks, { action: 'dispatch' }).pass, false);
  });
}

test('Conditional B is not a standalone dispatch trigger; independently requested C is', () => {
  const conditional = cases.find(row => row.id === 'conditional-work')!;
  const mixed = cases.find(row => row.id === 'conditional-and-independent-work')!;
  assert.equal(score(conditional, { action: 'ignore' }).pass, true);
  assert.equal(score(conditional, { action: 'dispatch' }).pass, false);
  assert.equal(score(mixed, { action: 'dispatch' }).pass, true);
  assert.equal(score(mixed, { action: 'ignore' }).pass, false);
});
