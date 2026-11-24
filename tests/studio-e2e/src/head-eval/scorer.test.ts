import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cases } from './cases';
import { score, summarize } from './scorer';
import { exercise } from './exercise';
const fixture = (id: string) => cases.find(row => row.id === id)!;
test('Relevance and observable reply/admission effects are scored separately; errors stay in denominator', () => {
  const testCase = fixture('combined');
  const good = score(testCase, { relevant: true, dispatched: true, hasReply: true });
  const missingAck = score(testCase, { relevant: true, dispatched: true, hasReply: false });
  assert.equal(good.pass, true);
  assert.equal(missingAck.relevancePass, true); assert.equal(missingAck.routePass, false);
  const failed = score(testCase, undefined, 'provider-error');
  const summary = summarize([good, missingAck, failed].map(score => ({ kind: 'contrast', score })));
  assert.deepEqual(summary.contrast.conditionalPass, { pass: 1, total: 2 });
  assert.equal(summary.contrast.total, 3); assert.equal(summary.errors, 1);
});
test('Busy additions conditional on success cannot be queued for either author', () => {
  for (const author of ['human', 'pet']) {
    const item = fixture('queue-' + author);
    assert.equal(score(item, { relevant: true, dispatched: false, hasReply: false }).pass, true);
    assert.equal(score(item, { relevant: false, dispatched: false, hasReply: false }).pass, false);
    assert.equal(score(item, { relevant: true, dispatched: true, hasReply: false }).pass, false);
  }
});
test('Plain progress stays reply-only; independent work can be queued', () => {
  const plain = fixture('progress-only');
  const followup = fixture('progress-and-addition');
  const work = fixture('busy-independent-work');
  const answered = { relevant: true, dispatched: false, hasReply: true };
  assert.equal(score(plain, answered).pass, true);
  assert.equal(score(plain, { ...answered, dispatched: true }).pass, false);
  assert.equal(score(plain, { ...answered, hasReply: false }).pass, false);
  assert.equal(score(followup, { ...answered, dispatched: true }).pass, true);
  assert.equal(score(work, { ...answered, dispatched: true, hasReply: false }).pass, true);
});
test('Fixture identities do not disclose route labels and preserve references', () => {
  for (const item of cases) {
    assert.equal(JSON.stringify(item.input).includes(item.id), false);
    assert.match(item.input.message.messageId, /^m-[a-f0-9]{16}$/);
    if (item.input.message.replyTo) assert.ok(item.input.context.messages.some(message => message.messageId === item.input.message.replyTo));
  }
});
test('Production routing exercise separates relevance from Session handling', async () => {
  for (const id of ['combined', 'queue-human', 'bare-mention-idle', 'bare-mention-busy', 'bare-mention-unknown', 'ignore-unrelated']) {
    const item = fixture(id);
    const calls: string[] = [];
    const result = await exercise(item, {
      assessRelevance: async () => { calls.push('relevance'); return { relevant: id !== 'ignore-unrelated' }; },
      decideNewWorkAndReply: async () => { calls.push('idle'); return { shouldDispatch: id === 'combined', reply: id === 'combined' ? '收到' : null }; },
      decideExecutionHandling: async () => { calls.push('handling'); return { delivery: null, reply: null }; },
    }, new AbortController().signal);
    assert.equal(score(item, result).pass, true, id);
    if (id.startsWith('bare-mention')) assert.equal(calls.includes('relevance'), false, 'canonical mention is relevance, not model routing');
    if (item.state !== 'idle') { assert.equal(calls.includes('idle'), false); assert.equal(result.dispatched, false); }
    if (id === 'ignore-unrelated') assert.deepEqual(calls, ['relevance']);
    if (id === 'combined') assert.deepEqual(calls, ['relevance', 'idle']);
  }
});
test('Idle review requests cannot pass by relevance alone; thanks and bare mention are not work', () => {
  for (const author of ['human', 'pet']) {
    assert.equal(score(fixture('addressed-review-' + author), { relevant: true, dispatched: false, hasReply: false }).pass, false);
    assert.equal(score(fixture('addressed-thanks-' + author), { relevant: true, dispatched: true, hasReply: false }).pass, false);
  }
  assert.equal(score(fixture('organic-peer'), { relevant: false, dispatched: false, hasReply: false }).pass, true);
});
