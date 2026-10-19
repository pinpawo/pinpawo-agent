import assert from 'node:assert/strict';
import test from 'node:test';
import { requiresLlmStreaming } from './llmModelPresets';

test('DeepSeek models stream so long replies are not cut off by the request timeout', () => {
  for (const model of ['deepseek-flash', 'deepseek-v4-flash', 'deepseek-v4-pro', 'deepseek-v4']) {
    assert.equal(requiresLlmStreaming(model), true, model);
  }
  assert.equal(requiresLlmStreaming('glm-4.5'), true);
  assert.equal(requiresLlmStreaming('gpt-5.5'), false);
});
