import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveOrchestratorRecursionLimit } from './createAgentRuntime';

// NODES_PER_DELEGATION = 5, ORCHESTRATOR_RECURSION_MARGIN = 10,
// DEFAULT_ORCHESTRATOR_MAX_ITERATIONS = 25.

test('derives the hard recursion limit from the default soft limit', () => {
  // 25 * 5 + 10
  assert.equal(resolveOrchestratorRecursionLimit(), 135);
  assert.equal(resolveOrchestratorRecursionLimit(undefined), 135);
});

test('derives from an explicit soft limit', () => {
  assert.equal(resolveOrchestratorRecursionLimit(10), 60); // 10*5+10
  assert.equal(resolveOrchestratorRecursionLimit(1), 15); // 1*5+10
});

test('falls back to the default for invalid soft limits', () => {
  assert.equal(resolveOrchestratorRecursionLimit(0), 135);
  assert.equal(resolveOrchestratorRecursionLimit(-3), 135);
  assert.equal(resolveOrchestratorRecursionLimit(2.5), 135);
});

test('hard limit always exceeds the soft limit it is derived from', () => {
  for (const soft of [1, 5, 10, 25, 50, 100]) {
    assert.ok(
      resolveOrchestratorRecursionLimit(soft) > soft,
      `recursion limit for soft=${soft} must exceed it`,
    );
  }
});
