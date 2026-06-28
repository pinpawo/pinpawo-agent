import assert from 'node:assert/strict';
import test from 'node:test';
import { AIMessage } from '@langchain/core/messages';
import {
  buildProviderUsageWatermarkTriggerTokens,
  evaluateProviderUsageWatermarkGuard,
} from './providerUsageWatermarkGuard';

function usageMessage(content: string, inputTokens: number) {
  return new AIMessage({
    content,
    usage_metadata: {
      input_tokens: inputTokens,
      output_tokens: 10,
      total_tokens: inputTokens + 10,
    },
  });
}

test('provider usage watermark guard triggers from latest message usage metadata', () => {
  const verdict = evaluateProviderUsageWatermarkGuard({
    messages: [
      usageMessage('old', 200),
      usageMessage('latest', 900),
    ],
    budgetTokens: 1000,
  });

  assert.deepEqual(verdict, {
    kind: 'provider_usage_watermark',
    triggered: true,
    latestInputTokens: 900,
    triggerTokens: 750,
  });
});

test('provider usage watermark guard stays idle below threshold and without signals', () => {
  assert.deepEqual(evaluateProviderUsageWatermarkGuard({
    latestInputTokens: 400,
    budgetTokens: 1000,
  }), {
    kind: 'provider_usage_watermark',
    triggered: false,
    latestInputTokens: 400,
    triggerTokens: 750,
  });

  assert.deepEqual(evaluateProviderUsageWatermarkGuard({
    messages: [new AIMessage('no usage')],
    budgetTokens: 1000,
  }), {
    kind: 'provider_usage_watermark',
    triggered: false,
    latestInputTokens: null,
    triggerTokens: 750,
  });

  assert.deepEqual(evaluateProviderUsageWatermarkGuard({
    latestInputTokens: 900,
  }), {
    kind: 'provider_usage_watermark',
    triggered: false,
    latestInputTokens: 900,
    triggerTokens: null,
  });
});

test('provider usage watermark guard supports explicit trigger and threshold ratio overrides', () => {
  assert.equal(buildProviderUsageWatermarkTriggerTokens({
    budgetTokens: 1000,
    thresholdRatio: 0.9,
  }), 900);

  assert.deepEqual(evaluateProviderUsageWatermarkGuard({
    latestInputTokens: 810,
    budgetTokens: 1000,
    thresholdRatio: 0.9,
  }), {
    kind: 'provider_usage_watermark',
    triggered: false,
    latestInputTokens: 810,
    triggerTokens: 900,
  });

  assert.deepEqual(evaluateProviderUsageWatermarkGuard({
    latestInputTokens: 810,
    budgetTokens: 1000,
    triggerTokens: 800,
  }), {
    kind: 'provider_usage_watermark',
    triggered: true,
    latestInputTokens: 810,
    triggerTokens: 800,
  });
});
