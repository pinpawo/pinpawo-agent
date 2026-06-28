import assert from 'node:assert/strict';
import test from 'node:test';
import {
  defineGuard,
  guardBlock,
  guardPass,
  GuardRegistry,
} from './guards';

type State = { count: number };
type Config = { limit: number };
type Position = 'before_decision' | 'after_decision';
type Update = { allowed: boolean; message?: string };

test('guard registry runs rule then handler with explicit state/config/position input', async () => {
  const guard = defineGuard<State, Config, Position, Update>({
    name: 'count_limit',
    positions: ['before_decision'],
    rule: {
      check: ({ state, config }) => state.count >= config.limit
        ? guardBlock('limit_reached', { count: state.count, limit: config.limit })
        : guardPass(),
    },
    handler: {
      handle: ({ config, result, state }) => {
        if (result.status === 'pass') {
          return { allowed: true };
        }
        return {
          allowed: false,
          message: `${result.reason}:${state.count}/${config.limit}`,
        };
      },
    },
  });
  const registry = new GuardRegistry<State, Config, Position, Update>();
  registry.register(guard);

  const run = await registry.run('count_limit', {
    state: { count: 3 },
    config: { limit: 2 },
    position: 'before_decision',
  });

  assert.equal(run.result.status, 'block');
  assert.deepEqual(run.update, { allowed: false, message: 'limit_reached:3/2' });
});

test('guard registry enforces registered positions', () => {
  const registry = new GuardRegistry<State, Config, Position, Update>();
  registry.register(defineGuard<State, Config, Position, Update>({
    name: 'positioned',
    positions: ['before_decision'],
    rule: { check: () => guardPass() },
    handler: { handle: () => ({ allowed: true }) },
  }));

  assert.throws(
    () => registry.check('positioned', {
      state: { count: 0 },
      config: { limit: 1 },
      position: 'after_decision',
    }),
    /not registered for position/,
  );
});
