import assert from 'node:assert/strict';
import test from 'node:test';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { createAutoReviewer } from './autoReviewer';
import { buildReviewSpec } from '../types/reviewSpec';
import type { AutoReviewAction } from './types';

function action(input: unknown): AutoReviewAction {
  return { toolkitName: 'example', toolName: 'write', input,
    review: buildReviewSpec({ view: { kind: 'plain', body: 'Write a report' }, options: [] }) };
}

test('AutoReviewer runs without Root, AgentModels, session or a Toolkit runtime', async () => {
  let invocations = 0;
  const model = { withStructuredOutput: () => ({ invoke: async (_messages: unknown, config: { callbacks: unknown[] }) => {
    invocations++;
    assert.deepEqual(config.callbacks, []);
    return { riskScore: 4, reason: 'Limited recovery cost.' };
  } }) } as unknown as BaseChatModel;
  const reviewer = createAutoReviewer({ model });
  for (const path of ['/project/a', '/project/b']) {
    const result = await reviewer.assess({ reviews: [action({ path, content: 'report' })] });
    assert.deepEqual(result, { complete: true, assessment: { riskScore: 4, reason: 'Limited recovery cost.' } });
    // The domain returns evidence, not a strict/relaxed approval or persisted grant.
    assert.equal('grant' in result, false);
    assert.equal('authorized' in result, false);
  }
  assert.equal(invocations, 2);
});

test('AutoReviewer preserves budget failure and leaves model failure handling to its caller', async () => {
  let invocations = 0;
  const failure = new Error('model unavailable');
  const model = { withStructuredOutput: () => ({ invoke: async () => { invocations++; throw failure; } }) } as unknown as BaseChatModel;
  const reviewer = createAutoReviewer({ model, structuredOutput: { autoRepair: false } });
  assert.deepEqual(await reviewer.assess({ reviews: [action({ content: 'x'.repeat(140_000) })] }), { complete: false });
  assert.equal(invocations, 0);
  await assert.rejects(reviewer.assess({ reviews: [action({ path: '/project/a' })] }), error => error === failure);
  assert.equal(invocations, 1);
});

test('AutoReviewer reads a null or missing reason as empty', async () => {
  const replies: unknown[] = [{ riskScore: 1, reason: null }, { riskScore: 2 }];
  const model = { withStructuredOutput: () => ({ invoke: async () => replies.shift() }) } as unknown as BaseChatModel;
  const reviewer = createAutoReviewer({ model, structuredOutput: { autoRepair: false } });
  for (const riskScore of [1, 2]) {
    assert.deepEqual(await reviewer.assess({ reviews: [action({ path: '/project/a' })] }),
      { complete: true, assessment: { riskScore, reason: '' } });
  }
});

test('runtime evidence reaches the model as source data and shares the input budget', async () => {
  const evidence = '/project/package.json\n{"scripts":{"build":"echo <source-marker>"}}';
  let calls = 0;
  const model = { withStructuredOutput: () => ({ invoke: async (messages: { content: string }[]) => {
    calls++;
    assert.ok(messages[1].content.includes(evidence));
    return { riskScore: 1, reason: 'test response' };
  } }) } as unknown as BaseChatModel;
  const reviewer = createAutoReviewer({ model });
  await reviewer.assess({ reviews: [{ ...action({ command: 'npm run build' }), evidence }] });
  assert.equal(calls, 1);
  assert.deepEqual(await reviewer.assess({ reviews: [{ ...action({ command: 'make' }), evidence: 'x'.repeat(140_000) }] }), { complete: false });
  assert.equal(calls, 1);
});
