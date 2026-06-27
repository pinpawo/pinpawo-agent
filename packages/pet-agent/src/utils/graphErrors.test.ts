import assert from 'node:assert/strict';
import test from 'node:test';
import { isGraphRecursionLimitError } from './graphErrors';

test('detects GraphRecursionError by lc_error_code', () => {
  const error = new Error('something');
  (error as { lc_error_code?: string }).lc_error_code = 'GRAPH_RECURSION_LIMIT';
  assert.equal(isGraphRecursionLimitError(error), true);
});

test('detects GraphRecursionError by message text', () => {
  assert.equal(
    isGraphRecursionLimitError(new Error('Recursion limit of 135 reached without hitting a stop condition.')),
    true,
  );
  assert.equal(isGraphRecursionLimitError(new Error('GRAPH_RECURSION_LIMIT')), true);
});

test('does not match unrelated errors or non-errors', () => {
  assert.equal(isGraphRecursionLimitError(new Error('boom')), false);
  assert.equal(isGraphRecursionLimitError('Recursion limit of 25 reached'), false);
  assert.equal(isGraphRecursionLimitError(null), false);
  assert.equal(isGraphRecursionLimitError(undefined), false);
});
