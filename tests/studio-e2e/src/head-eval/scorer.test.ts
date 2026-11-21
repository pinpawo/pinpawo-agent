import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cases } from './cases';
import { score, summarize } from './scorer';
test('Head eval distinguishes work and reply presence, handling, invalidity and provider failure', () => {
  const combined = cases.find(row => row.id === 'combined')!;
  const good = score(combined, { action: 'handle', reply: '收到', intent: '核对' });
  assert.equal(good.pass, true);
  const wrong = score(combined, { action: 'handle', reply: '', intent: '核对' });
  assert.equal(wrong.workIntentPass, true); assert.equal(wrong.replyPresencePass, false);
  assert.deepEqual([wrong.valid, wrong.routePass, wrong.handlingPass], [true, false, true]);
  const failed = score(combined, undefined, 'provider-error');
  const summary = summarize([{ kind: 'contrast', score: good }, { kind: 'contrast', score: wrong }, { kind: 'contrast', score: failed }]);
  assert.deepEqual(summary.contrast.conditionalDecisionPass, { pass: 1, total: 2 });
  assert.equal(summary.contrast.total, 3); assert.equal(summary.errors, 1);
});
test('Organic cases are acceptance sets, not exact behavior accuracy', () => {
  const organic = cases.find(row => row.kind === 'organic')!;
  assert.equal(score(organic, { action: 'pass' }).pass, true);
  assert.equal(score(organic, { action: 'direct', reply: '待核查', intent: '' }).pass, true);
  assert.equal(score(organic, { action: 'direct', reply: '', intent: 'invalid' }).valid, false);
});
test('Independent additions and unsupported edits are author neutral; follow-up has no mention and grounded prior reply', () => {
  for (const author of ['human', 'pet']) {
    const queued = cases.find(row => row.id === `queue-${author}`)!;
    const unsupportedEdit = cases.find(row => row.id === `unsupported-edit-${author}`)!;
    assert.equal(score(queued, { action: 'handle', reply: '', intent: 'work' }).pass, true);
    assert.equal(score(unsupportedEdit, { action: 'direct', reply: '无法更改正在执行的任务。', intent: '' }).pass, true);
    assert.equal(score(unsupportedEdit, { action: 'handle', reply: '', intent: 'work' }).pass, false);
  }
  const follow = cases.find(row => row.id === 'no-at-followup')!.input;
  assert.deepEqual(follow.message.mentions, []);
  assert.equal(follow.message.replyTo, follow.context.messages[0]!.messageId);
});

test('Peer acknowledgement cannot revive a previous combined human request', () => {
  const testCase = cases.find(row => row.id === 'peer-ack-not-new-request')!;
  assert.equal(testCase.input.message.author.kind, 'pet');
  assert.equal(testCase.input.message.replyTo, testCase.input.context.messages[0]!.messageId);
  assert.equal(score(testCase, { action: 'pass' }).pass, true);
  for (const decision of [
    { action: 'direct' as const, reply: '收到', intent: '' },
    { action: 'handle' as const, reply: '', intent: '重复核对' },
  ]) assert.equal(score(testCase, decision).pass, false);
});

test('Substantive direct peer question is not satisfied by ignoring every Pet', () => {
  const testCase = cases.find(row => row.id === 'peer-direct-ask')!;
  assert.equal(score(testCase, { action: 'direct', reply: '同比比较去年同期，环比比较上一期。', intent: '' }).pass, true);
  assert.equal(score(testCase, { action: 'direct', reply: '  ', intent: '' }).pass, false);
});

test('Execution facts and independently executable work are distinct', () => {
  const progress = cases.find(row => row.id === 'progress-only')!;
  const mixed = cases.find(row => row.id === 'progress-and-addition')!;
  assert.equal(score(progress, { action: 'handle' }).pass, true);
  assert.equal(score(progress, { action: 'handle', reply: null, intent: null }).pass, true);
  assert.equal(score(progress, { action: 'pass' }).pass, false);
  assert.equal(score(mixed, { action: 'handle', intent: 'New work' }).pass, true);
});

for (const author of ['human', 'pet'] as const) {
  test(`Explicit ${author} addressing fixes ownership, not the need to handle work`, () => {
    const fixture = cases.find(row => row.id === `addressed-review-${author}`)!;
    assert.equal(fixture.input.message.author.kind, author);
    assert.equal(score(fixture, { action: 'handle', intent: 'Audit revenue.' }).pass, true);
    assert.equal(score(fixture, { action: 'direct' }).valid, true);
    assert.equal(score(fixture, { action: 'direct' }).pass, false);
    assert.equal(score(fixture, { action: 'pass' }).valid, false);
  });
}
