import assert from 'node:assert/strict';
import test from 'node:test';
import { cases } from './cases';
import { selectCases } from './selection';
import { readCacheUsage } from './cacheUsage';
import { relevanceCases } from './relevanceCases';

test('Explicit subsets and repeats obey the offline decision cap', () => {
  const selected = selectCases(['combined', 'no-at-followup'], 1);
  assert.deepEqual(selected.map(row => row.id), ['combined', 'no-at-followup']);
  assert.equal(selectCases(['combined', 'no-at-followup'], 10).length, 2);
  assert.throws(() => selectCases(['combined', 'no-at-followup'], 11), /maximum-20/);
  assert.throws(() => selectCases(undefined, 1), /maximum-20/);
  for (const repeats of [0, -1, 1.5, NaN]) assert.throws(() => selectCases(['combined'], repeats));
  assert.throws(() => selectCases([], 1));
  assert.throws(() => selectCases(['unknown'], 1), /unknown-case/);
});

test('Relevance contrasts stay separate from runtime-effect scoring and have distinct expectations', () => {
  assert.equal(relevanceCases.length, 3);
  assert.deepEqual(relevanceCases.map(row => row.expected), [
    { relevant: true, relation: 'replacement', preserveA: false, bAfterA: false },
    { relevant: true, relation: 'ordered', preserveA: true, bAfterA: true },
    { relevant: true, relation: 'guidance', preserveA: true, bAfterA: false },
  ]);
  for (const row of relevanceCases) {
    assert.equal(cases.some(existing => existing.id === row.id), false);
    assert.deepEqual(Object.keys(row.input).sort(), ['message', 'previous']);
    assert.notEqual(row.input.message.messageId, row.input.previous.messageId);
    assert.equal(JSON.stringify(row.input).includes(row.id), false);
  }
});

test('Cache telemetry preserves misses, hits and absent data without affecting scores', () => {
  assert.deepEqual(readCacheUsage({ prompt_cache_hit_tokens: 10, prompt_cache_miss_tokens: 3 }), { cacheHitTokens: 10, cacheMissTokens: 3 });
  assert.deepEqual(readCacheUsage({ prompt_tokens_details: { cached_tokens: 0 } }), { cacheHitTokens: 0 });
  assert.deepEqual(readCacheUsage({ cache_read_input_tokens: 8 }), { cacheHitTokens: 8 });
  assert.deepEqual(readCacheUsage({ prompt_cache_hit_tokens: -1, prompt_cache_miss_tokens: NaN }), {});
  assert.deepEqual(readCacheUsage(undefined), {});
});
