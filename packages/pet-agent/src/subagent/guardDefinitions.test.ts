import assert from 'node:assert/strict';
import test from 'node:test';
import { evaluateGuard } from '../guards';
import {
  SUBAGENT_GUARD_POSITION,
  SUBAGENT_ITERATION_LIMIT_REACHED,
  subagentIterationLimitGuard,
} from './guardDefinitions';
import {
  buildSubagentIterationLimitStopNotice,
  readSubagentGuardStopReason,
} from './guardStop';

test('subagent iteration limit guard stops past the budget with the count evidence', () => {
  const stop = evaluateGuard(subagentIterationLimitGuard, {
    state: { iterationCount: 5, maxIterations: 4 },
    config: {},
    position: SUBAGENT_GUARD_POSITION.BEFORE_MODEL_ITERATION,
  });
  assert.equal(stop.kind, 'stop');
  assert.equal(stop.kind === 'stop' && stop.reason, SUBAGENT_ITERATION_LIMIT_REACHED);
  assert.deepEqual(stop.kind === 'stop' && stop.details, {
    iterationCount: 5,
    maxIterations: 4,
  });

  const proceed = evaluateGuard(subagentIterationLimitGuard, {
    state: { iterationCount: 4, maxIterations: 4 },
    config: {},
    position: SUBAGENT_GUARD_POSITION.BEFORE_MODEL_ITERATION,
  });
  assert.equal(proceed.kind, 'proceed');
});

test('iteration limit stop notice carries the closed guard stop marker', () => {
  const notice = buildSubagentIterationLimitStopNotice(5, 4);

  assert.match(String(notice.content), /attempted 5, limit 4/);
  assert.equal(readSubagentGuardStopReason(notice), 'subagent_iteration_limit_reached');
});
