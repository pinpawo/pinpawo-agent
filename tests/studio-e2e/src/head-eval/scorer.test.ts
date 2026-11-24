import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cases } from './cases';
import { score, summarize } from './scorer';
import { exercise } from './exercise';
const fixture = (id: string) => cases.find(row => row.id === id)!;
test('Relevance and observable reply/admission effects are scored separately; errors stay in denominator', () => {
  const testCase = fixture('combined');
  const good = score(testCase, { relevant: true, delivery: 'idle-only', hasReply: true });
  const missingAck = score(testCase, { relevant: true, delivery: 'idle-only', hasReply: false });
  assert.equal(good.pass, true);
  assert.equal(missingAck.relevancePass, true); assert.equal(missingAck.deliveryPass, true);
  assert.equal(missingAck.replyPass, false); assert.equal(missingAck.routePass, false);
  const failed = score(testCase, undefined, 'provider-error');
  const summary = summarize([good, missingAck, failed].map(score => ({ kind: 'contrast', score })));
  assert.deepEqual(summary.contrast.conditionalPass, { pass: 1, total: 2 });
  assert.equal(summary.contrast.deliveryPass, 2); assert.equal(summary.contrast.replyPass, 1);
  assert.equal(summary.contrast.total, 3); assert.equal(summary.errors, 1);
});
test('Busy additions conditional on success cannot be queued for either author', () => {
  for (const author of ['human', 'pet']) {
    const item = fixture('queue-' + author);
    assert.equal(score(item, { relevant: true, delivery: null, hasReply: false }).pass, true);
    assert.equal(score(item, { relevant: false, delivery: null, hasReply: false }).pass, false);
    assert.equal(score(item, { relevant: true, delivery: 'queue', hasReply: false }).pass, false);
  }
});
test('Plain progress stays reply-only; independent work can be queued', () => {
  const plain = fixture('progress-only');
  const followup = fixture('progress-and-addition');
  const work = fixture('busy-independent-work');
  const answered = { relevant: true, delivery: null, hasReply: true };
  assert.equal(score(plain, answered).pass, true);
  assert.equal(score(plain, { ...answered, delivery: 'queue' }).pass, false);
  assert.equal(score(plain, { ...answered, hasReply: false }).pass, false);
  assert.equal(score(followup, { ...answered, delivery: 'queue' }).pass, true);
  assert.equal(score(work, { ...answered, delivery: 'queue', hasReply: false }).pass, true);
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
      suggestDispatchForExistingWork: async () => { calls.push('handling'); return { delivery: null, reply: null }; },
    }, new AbortController().signal);
    assert.equal(score(item, result).pass, true, id);
    if (id.startsWith('bare-mention')) assert.equal(calls.includes('relevance'), false, 'canonical mention is relevance, not model routing');
    if (item.state !== 'idle') { assert.equal(calls.includes('idle'), false); assert.equal(result.delivery, null); }
    if (id === 'ignore-unrelated') assert.deepEqual(calls, ['relevance']);
    if (id === 'combined') assert.deepEqual(calls, ['relevance', 'idle']);
  }
});
test('Idle review requests cannot pass by relevance alone; thanks and bare mention are not work', () => {
  for (const author of ['human', 'pet']) {
    assert.equal(score(fixture('addressed-review-' + author), { relevant: true, delivery: null, hasReply: false }).pass, false);
    assert.equal(score(fixture('addressed-thanks-' + author), { relevant: true, delivery: 'idle-only', hasReply: false }).pass, false);
  }
  assert.equal(score(fixture('organic-peer'), { relevant: false, delivery: null, hasReply: false }).pass, true);
});

test('dispatch kind is exact even when the reply effect is correct', () => {
  const allowed = [
    ['combined', 'idle-only', true], ['progress-and-addition', 'queue', true],
    ['busy-explicit-replacement', null, true], ['bare-mention-unknown', null, false],
  ] as const;
  for (const [id, expected, hasReply] of allowed) {
    for (const delivery of [null, 'idle-only', 'queue', 'interrupt'] as const) {
      const result = score(fixture(id), { relevant: true, delivery, hasReply });
      const label = `${id} receiving ${delivery}`;
      assert.equal(result.valid, true, label);
      assert.equal(result.replyPass, true, label);
      assert.equal(result.deliveryPass, delivery === expected, label);
      assert.equal(result.pass, delivery === expected, label);
    }
  }
});

test('an observation cannot mix effects from different accepted routes', () => {
  const result = score({ ...fixture('combined'), routes: ['silent', 'combined'] }, { relevant: true, delivery: 'idle-only', hasReply: false });
  assert.equal(result.deliveryPass, true);
  assert.equal(result.replyPass, true);
  assert.equal(result.routePass, false);
});

test('unknown state cannot admit dispatch even if fixture metadata otherwise allows it', () => {
  const item = fixture('busy-independent-work');
  const observation = { relevant: true, delivery: 'queue', hasReply: false } as const;
  assert.equal(score(item, observation).pass, true);
  assert.equal(score({ ...item, state: 'unknown' }, observation).deliveryPass, false);
});

test('the synthetic observer scores the delivery actually requested from the dispatch port', async () => {
  for (const [id, delivery, reply, expected] of [
    ['progress-and-addition', 'queue', '已收到。', true],
    ['progress-and-addition', null, '仍在核对。', false],
    ['progress-and-addition', 'queue', null, false],
    ['busy-explicit-replacement', null, '不能停止当前核对。', true],
    ['busy-explicit-replacement', 'queue', '不能停止当前核对。', false],
  ] as const) {
    const item = fixture(id);
    const observation = await exercise(item, {
      assessRelevance: async () => ({ relevant: true }),
      decideNewWorkAndReply: async () => assert.fail('the fixture is running'),
      suggestDispatchForExistingWork: async () => ({ delivery, reply }),
    }, new AbortController().signal);
    assert.deepEqual(observation, { relevant: true, delivery, hasReply: reply !== null });
    assert.equal(score(item, observation).pass, expected);
  }
});
