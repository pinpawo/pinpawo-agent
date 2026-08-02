import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createLocalModelRequestPolicy,
  normalizeLocalToolChoice,
} from './localModelRequestPolicy';

test('auto-only models normalize every forced tool choice', () => {
  for (const toolChoice of [
    'any',
    'required',
    'submit_plan',
    { type: 'function', function: { name: 'submit_plan' } },
  ]) {
    assert.equal(normalizeLocalToolChoice('auto_only', toolChoice), 'auto');
  }
  assert.equal(normalizeLocalToolChoice('auto_only', 'none'), 'none');
  assert.equal(normalizeLocalToolChoice('auto_only', 'auto'), 'auto');
  assert.equal(normalizeLocalToolChoice('auto_only', undefined), undefined);
});

test('models with full tool-choice support preserve forced selection', () => {
  const policy = createLocalModelRequestPolicy({
    apiKey: 'test-key',
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-5.5',
  });

  assert.equal(policy.normalizeToolChoice?.('required'), 'required');
  assert.deepEqual(
    policy.normalizeToolChoice?.({
      type: 'function',
      function: { name: 'submit_plan' },
    }),
    { type: 'function', function: { name: 'submit_plan' } },
  );
});
