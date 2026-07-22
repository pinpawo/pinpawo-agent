import assert from 'node:assert/strict';
import test from 'node:test';
import { AIMessage } from '@langchain/core/messages';
import type { LLMResult } from '@langchain/core/outputs';
import {
  estimatePromptEvalCost,
  readLlmResultTokenUsage,
} from './prompt-eval-usage.ts';

test('reads provider usage from chat generations', () => {
  const usage = readLlmResultTokenUsage({
    generations: [[{
      text: 'ok',
      message: new AIMessage({
        content: 'ok',
        usage_metadata: { input_tokens: 120, output_tokens: 8, total_tokens: 128 },
      }),
    }]],
  } as unknown as LLMResult);
  assert.deepEqual(usage, { inputTokens: 120, outputTokens: 8, totalTokens: 128 });
});

test('falls back to llmOutput token usage', () => {
  const usage = readLlmResultTokenUsage({
    generations: [[]],
    llmOutput: { tokenUsage: { promptTokens: 20, completionTokens: 4, totalTokens: 24 } },
  });
  assert.deepEqual(usage, { inputTokens: 20, outputTokens: 4, totalTokens: 24 });
});

test('estimates cost only when both usage and explicit pricing exist', () => {
  const usage = { inputTokens: 1_000_000, outputTokens: 500_000, totalTokens: 1_500_000 };
  assert.equal(estimatePromptEvalCost(usage, {
    inputUsdPerMillionTokens: 2,
    outputUsdPerMillionTokens: 4,
  }), 4);
  assert.equal(estimatePromptEvalCost(usage, null), null);
  assert.equal(estimatePromptEvalCost(null, {
    inputUsdPerMillionTokens: 2,
    outputUsdPerMillionTokens: 4,
  }), null);
});
