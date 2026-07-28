import assert from 'node:assert/strict';
import test from 'node:test';
import { ORCHESTRATOR_RECURSION_LIMIT } from './controlPrimitives';

test('ORCHESTRATOR_RECURSION_LIMIT comfortably exceeds a healthy run', () => {
  // The hard breaker is a flat last-resort value, not derived. It must sit well
  // above what a healthy run consumes: the soft guard's default 25 delegations,
  // each walking a handful of graph nodes (~100 nodes total). 200 leaves headroom.
  assert.ok(
    ORCHESTRATOR_RECURSION_LIMIT > 100,
    `recursion limit ${ORCHESTRATOR_RECURSION_LIMIT} must exceed a healthy run's node count`,
  );
});
