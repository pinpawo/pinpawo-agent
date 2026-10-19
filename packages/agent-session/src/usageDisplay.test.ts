import assert from 'node:assert/strict';
import test from 'node:test';
import { formatSessionUsageMetrics } from './usageDisplay';
import { parseTokenUsageSnapshot } from '@pinpawo/agent-contracts';

test('shared status preserves unknown, partial cache coverage and provisional speed through parsing', () => {
  assert.equal(formatSessionUsageMetrics({}), 'cache: – · out: – tok/s · session: –');
  const usage = parseTokenUsageSnapshot({ inputTokens: 1000, outputTokens: 200, totalTokens: 1200,
    cachedInputTokens: 100, cacheEligibleInputTokens: 200, incomplete: true, unknownCalls: 1,
    outputTokensPerSecond: 20, outputRateSource: 'stream', scope: 'session' });
  assert.ok(usage);
  assert.equal(formatSessionUsageMetrics({ tokenUsage: usage }), 'cache: 50%* · out: ~20.0 tok/s · session: ≥1,200');
  assert.equal(formatSessionUsageMetrics({ tokenUsage: { ...usage, cachedInputTokens: 0, cacheEligibleInputTokens: 1000,
    outputRateSource: 'final' } }), 'cache: 0%* · out: 20.0 tok/s · session: ≥1,200');
});


test('unknown failed calls mark cache coverage partial even when their input count is unavailable', () => {
  assert.equal(formatSessionUsageMetrics({ sessionTokenUsage: { inputTokens: 100, outputTokens: 20, totalTokens: 120,
    cachedInputTokens: 50, cacheEligibleInputTokens: 100, unknownCalls: 1, incomplete: true, scope: 'session' } }),
  'cache: 50%* · out: – tok/s · session: ≥120');
});
