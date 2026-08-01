import assert from 'node:assert/strict';
import test from 'node:test';
import { inferLlmContextWindowTokens } from './llmContextWindow';

test('inferLlmContextWindowTokens covers mainstream model families', () => {
  assert.equal(inferLlmContextWindowTokens('deepseek-v4-pro'), 1_000_000);
  assert.equal(inferLlmContextWindowTokens('gpt-5.5'), 1_000_000);
  assert.equal(inferLlmContextWindowTokens('gpt-5.4-mini'), 400_000);
  assert.equal(inferLlmContextWindowTokens('gpt-4.1-mini'), 1_047_576);
  assert.equal(inferLlmContextWindowTokens('gpt-4o'), 128_000);
  assert.equal(inferLlmContextWindowTokens('claude-sonnet-4-6'), 1_000_000);
  assert.equal(inferLlmContextWindowTokens('claude-sonnet-4.5-20250929'), 1_000_000);
  assert.equal(inferLlmContextWindowTokens('gemini-1.5-pro'), 2_097_152);
  assert.equal(inferLlmContextWindowTokens('gemini-3.5-flash'), 1_048_576);
  assert.equal(inferLlmContextWindowTokens('gemini-2.5-flash'), 1_048_576);
  assert.equal(inferLlmContextWindowTokens('glm-5.2'), 1_000_000);
  assert.equal(inferLlmContextWindowTokens('glm-5.1'), 200_000);
  assert.equal(inferLlmContextWindowTokens('kimi-k2.6'), 256_000);
  assert.equal(inferLlmContextWindowTokens('MiniMax-M2.7'), 192_000);
  assert.equal(inferLlmContextWindowTokens('qwen3.8-max-preview'), 1_000_000);
  assert.equal(inferLlmContextWindowTokens('qwen3.7-max'), 1_000_000);
  assert.equal(inferLlmContextWindowTokens('qwen3.6-flash'), 1_000_000);
  assert.equal(inferLlmContextWindowTokens('qwen3.5-plus'), 1_000_000);
  assert.equal(inferLlmContextWindowTokens('qwen3-coder-plus'), 256_000);
  assert.equal(inferLlmContextWindowTokens('qwen2.5-72b-instruct'), 128_000);
  assert.equal(inferLlmContextWindowTokens('qwen2.5-7b-instruct-1m'), 1_000_000);
});

test('inferLlmContextWindowTokens falls back to undefined for unknown models', () => {
  assert.equal(inferLlmContextWindowTokens('my-custom-model'), undefined);
  assert.equal(inferLlmContextWindowTokens(''), undefined);
  assert.equal(inferLlmContextWindowTokens(null), undefined);
});
