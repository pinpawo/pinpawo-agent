import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cases } from './cases';
import { score, summarize } from './scorer';
test('Head eval distinguishes routing presence, timing, invalidity and provider failure', () => {
  const combined = cases.find(row => row.id === 'combined')!;
  const good = score(combined, { action: 'dispatch', reply: '收到', intent: '核对', timing: 'enqueue' });
  assert.equal(good.pass, true);
  const wrong = score(combined, { action: 'dispatch', reply: '', intent: '核对', timing: 'enqueue' });
  assert.deepEqual([wrong.valid, wrong.routePass, wrong.timingPass], [true, false, true]);
  const failed = score(combined, undefined, 'provider-error');
  const summary = summarize([{ kind: 'contrast', score: good }, { kind: 'contrast', score: wrong }, { kind: 'contrast', score: failed }]);
  assert.deepEqual(summary.contrast.conditionalRoutingTiming, { pass: 1, total: 2 });
  assert.equal(summary.contrast.total, 3); assert.equal(summary.errors, 1);
});
test('Organic cases are acceptance sets, not exact behavior accuracy', () => {
  const organic = cases.find(row => row.kind === 'organic')!;
  assert.equal(score(organic, { action: 'ignore', reply: '', intent: '', timing: 'enqueue' }).pass, true);
  assert.equal(score(organic, { action: 'ignore', reply: '待核查', intent: '', timing: 'enqueue' }).pass, true);
  assert.equal(score(organic, { action: 'ignore', reply: '', intent: 'invalid', timing: 'enqueue' }).valid, false);
});
test('Timing contrasts are author neutral; follow-up has no mention and grounded prior reply', () => {
  for (const author of ['human', 'pet']) {
    const queued = cases.find(row => row.id === `queue-${author}`)!;
    const interrupt = cases.find(row => row.id === `interrupt-${author}`)!;
    assert.equal(score(queued, { action: 'dispatch', reply: '', intent: 'work', timing: 'enqueue' }).pass, true);
    assert.equal(score(interrupt, { action: 'dispatch', reply: '', intent: 'work', timing: 'interrupt' }).pass, true);
  }
  const follow = cases.find(row => row.id === 'no-at-followup')!.input;
  assert.deepEqual(follow.message.mentions, []);
  assert.equal(follow.message.replyTo, follow.context.messages[0]!.messageId);
});

test('Peer acknowledgement cannot revive a previous combined human request', () => {
  const testCase = cases.find(row => row.id === 'peer-ack-not-new-request')!;
  assert.equal(testCase.input.message.author.kind, 'pet');
  assert.equal(testCase.input.message.replyTo, testCase.input.context.messages[0]!.messageId);
  assert.equal(score(testCase, { action: 'ignore', reply: '', intent: '', timing: 'enqueue' }).pass, true);
  for (const decision of [
    { action: 'ignore' as const, reply: '收到', intent: '', timing: 'enqueue' as const },
    { action: 'dispatch' as const, reply: '', intent: '重复核对', timing: 'enqueue' as const },
  ]) assert.equal(score(testCase, decision).pass, false);
});
