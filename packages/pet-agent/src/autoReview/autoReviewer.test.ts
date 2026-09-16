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
