import assert from 'node:assert/strict';
import test from 'node:test';
import {
  defineGuard,
  evaluateGuard,
  guardDerive,
  guardMaintain,
  guardProceed,
  guardStop,
  type GuardDecisionRecord,
} from './guards';

type State = { count: number };
type Config = { limit: number };
type Position = 'before_decision' | 'after_decision';

const countLimitGuard = defineGuard<State, Config, Position>({
  name: 'count_limit',
  positions: ['before_decision'],
  check: ({ state, config }) => state.count >= config.limit
    ? guardStop('limit_reached', { count: state.count, limit: config.limit })
    : guardProceed(),
});

test('outcome constructors produce the discriminated union verbs', () => {
  assert.deepEqual(guardProceed(), { kind: 'proceed' });
  assert.deepEqual(guardStop('r'), { kind: 'stop', reason: 'r' });
  assert.deepEqual(
    guardMaintain('r', { watermarkTokens: 750 }),
    { kind: 'maintain', reason: 'r', details: { watermarkTokens: 750 } },
  );
  assert.deepEqual(guardDerive('r'), { kind: 'derive', reason: 'r' });
});

test('defineGuard rejects a guard without positions', () => {
  assert.throws(
    () => defineGuard<State, Config, Position>({
      name: 'empty_positions',
      positions: [],
      check: () => guardProceed(),
    }),
    /at least one position/,
  );
});

test('evaluateGuard returns the rule outcome for a declared position', () => {
  const stop = evaluateGuard(countLimitGuard, {
    state: { count: 3 },
    config: { limit: 2 },
    position: 'before_decision',
  });
  assert.deepEqual(stop, {
    kind: 'stop',
    reason: 'limit_reached',
    details: { count: 3, limit: 2 },
  });

  const proceed = evaluateGuard(countLimitGuard, {
    state: { count: 1 },
    config: { limit: 2 },
    position: 'before_decision',
  });
  assert.deepEqual(proceed, { kind: 'proceed' });
});

test('evaluateGuard emits one decision record per evaluation', () => {
  const records: GuardDecisionRecord[] = [];

  evaluateGuard(countLimitGuard, {
    state: { count: 3 },
    config: { limit: 2 },
    position: 'before_decision',
  }, {
    emit: (record) => records.push(record),
    runId: 'run-1',
    iteration: 3,
  });
  evaluateGuard(countLimitGuard, {
    state: { count: 0 },
    config: { limit: 2 },
    position: 'before_decision',
  }, { emit: (record) => records.push(record) });

  assert.deepEqual(records, [
    {
      guard: 'count_limit',
      position: 'before_decision',
      outcome: { kind: 'stop', reason: 'limit_reached', details: { count: 3, limit: 2 } },
      runId: 'run-1',
      iteration: 3,
    },
    {
      guard: 'count_limit',
      position: 'before_decision',
      outcome: { kind: 'proceed' },
    },
  ]);
});

test('evaluateGuard never lets a throwing emitter fail the decision', () => {
  const outcome = evaluateGuard(countLimitGuard, {
    state: { count: 3 },
    config: { limit: 2 },
    position: 'before_decision',
  }, {
    emit: () => {
      throw new Error('emitter exploded');
    },
  });

  assert.equal(outcome.kind, 'stop');
});

test('evaluateGuard enforces declared positions', () => {
  assert.throws(
    () => evaluateGuard(countLimitGuard, {
      state: { count: 0 },
      config: { limit: 2 },
      position: 'after_decision',
    }),
    /not declared for position/,
  );
});
