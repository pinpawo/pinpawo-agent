import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cases } from './cases';
import { score, summarize } from './scorer';
test('Head eval distinguishes routing presence, progress reads, invalidity and provider failure', () => {
  const combined = cases.find(row => row.id === 'combined')!;
  const good = score(combined, { action: 'dispatch', reply: '收到', intent: '核对' });
  assert.equal(good.pass, true);
  const wrong = score(combined, { action: 'dispatch', reply: '', intent: '核对' });
  assert.equal(wrong.actionPass, true); assert.equal(wrong.replyPresencePass, false);
  assert.deepEqual([wrong.valid, wrong.routePass, wrong.progressReadPass], [true, false, true]);
  const failed = score(combined, undefined, 'provider-error');
  const summary = summarize([{ kind: 'contrast', score: good }, { kind: 'contrast', score: wrong }, { kind: 'contrast', score: failed }]);
  assert.deepEqual(summary.contrast.conditionalRoutingProgress, { pass: 1, total: 2 });
  assert.equal(summary.contrast.total, 3); assert.equal(summary.errors, 1);
});
test('Organic cases are acceptance sets, not exact behavior accuracy', () => {
  const organic = cases.find(row => row.kind === 'organic')!;
  assert.equal(score(organic, { action: 'ignore', reply: '', intent: '' }).pass, true);
  assert.equal(score(organic, { action: 'ignore', reply: '待核查', intent: '' }).pass, true);
  assert.equal(score(organic, { action: 'ignore', reply: '', intent: 'invalid' }).valid, false);
});
test('Independent additions and unsupported edits are author neutral; follow-up has no mention and grounded prior reply', () => {
  for (const author of ['human', 'pet']) {
    const queued = cases.find(row => row.id === `queue-${author}`)!;
    const unsupportedEdit = cases.find(row => row.id === `unsupported-edit-${author}`)!;
    assert.equal(score(queued, { action: 'dispatch', reply: '', intent: 'work' }).pass, true);
    assert.equal(score(unsupportedEdit, { action: 'ignore', reply: '无法更改正在执行的任务。', intent: '' }).pass, true);
    assert.equal(score(unsupportedEdit, { action: 'dispatch', reply: '', intent: 'work' }).pass, false);
  }
  const follow = cases.find(row => row.id === 'no-at-followup')!.input;
  assert.deepEqual(follow.message.mentions, []);
  assert.equal(follow.message.replyTo, follow.context.messages[0]!.messageId);
});

test('Peer acknowledgement cannot revive a previous combined human request', () => {
  const testCase = cases.find(row => row.id === 'peer-ack-not-new-request')!;
  assert.equal(testCase.input.message.author.kind, 'pet');
  assert.equal(testCase.input.message.replyTo, testCase.input.context.messages[0]!.messageId);
  assert.equal(score(testCase, { action: 'ignore', reply: '', intent: '' }).pass, true);
  for (const decision of [
    { action: 'ignore' as const, reply: '收到', intent: '' },
    { action: 'dispatch' as const, reply: '', intent: '重复核对' },
  ]) assert.equal(score(testCase, decision).pass, false);
});

test('Substantive direct peer question is not satisfied by ignoring every Pet', () => {
  const testCase = cases.find(row => row.id === 'peer-direct-ask')!;
  assert.equal(score(testCase, { action: 'ignore', reply: '同比比较去年同期，环比比较上一期。', intent: '' }).pass, true);
  assert.equal(score(testCase, { action: 'ignore', reply: '  ', intent: '' }).pass, false);
});

test('Progress-only and independent additions must stay separate', () => {
  const progress = cases.find(row => row.id === 'progress-only')!;
  const mixed = cases.find(row => row.id === 'progress-and-addition')!;
  assert.equal(score(progress, { action: 'ignore', reply: '', intent: '', readProgress: true }).pass, true);
  assert.equal(score(progress, { action: 'ignore', reply: '', intent: '' }).pass, false);
  assert.equal(score(mixed, { action: 'dispatch', reply: '', intent: 'New work', readProgress: true }).pass, true);
});
