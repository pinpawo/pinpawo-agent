import assert from 'node:assert/strict';
import test from 'node:test';
import {
  defineGuard,
  guardBlock,
  guardPass,
  GuardRegistry,
  createGuardRunner,
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

test('guard registry binds a position onBlock callback per run', async () => {
  const guard = defineGuard<State, Config, Position, Update>({
    name: 'count_limit',
    positions: ['before_decision'],
    rule: {
      check: ({ state, config }) => state.count >= config.limit
        ? guardBlock('limit_reached')
        : guardPass(),
    },
    handler: {
      handle: () => ({ allowed: true }),
    },
  });
  const registry = new GuardRegistry<State, Config, Position, Update>();
  registry.register(guard);

  const run = await registry.run('count_limit', {
    state: { count: 3 },
    config: { limit: 2 },
    position: 'before_decision',
  }, {
    onBlock: ({ guardName, result, state }) => ({
      allowed: false,
      message: `${guardName}:${result.reason}:${state.count}`,
    }),
  });

  assert.equal(run.result.status, 'block');
  assert.deepEqual(run.update, {
    allowed: false,
    message: 'count_limit:limit_reached:3',
  });
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

test('guard runner adapts runtime input into guard input', async () => {
  const registry = new GuardRegistry<State, Config, Position, Update>();
  registry.register(defineGuard<State, Config, Position, Update>({
    name: 'count_limit',
    positions: ['before_decision'],
    rule: {
      check: ({ state, config }) => state.count >= config.limit
        ? guardBlock('limit_reached')
        : guardPass(),
    },
    handler: {
      handle: ({ result }) => result.status === 'block'
        ? { allowed: false }
        : { allowed: true },
    },
  }));
  const runGuard = createGuardRunner<
    'count_limit',
    State,
    Config,
    Position,
    Update,
    { count: number; limit: number }
  >({
    registry,
    adapter: {
      toGuardInput: (position, input) => ({
        state: { count: input.count },
        config: { limit: input.limit },
        position,
      }),
    },
  });

  const run = await runGuard('count_limit', 'before_decision', { count: 3, limit: 2 });

  assert.equal(run.result.status, 'block');
  assert.deepEqual(run.update, { allowed: false });
});

test('guard runner forwards position-bound onBlock callbacks', async () => {
  const registry = new GuardRegistry<State, Config, Position, Update>();
  registry.register(defineGuard<State, Config, Position, Update>({
    name: 'count_limit',
    positions: ['before_decision'],
    rule: {
      check: () => guardBlock('limit_reached'),
    },
    handler: {
      handle: () => ({ allowed: true }),
    },
  }));
  const runGuard = createGuardRunner<
    'count_limit',
    State,
    Config,
    Position,
    Update,
    State
  >({
    registry,
    adapter: {
      toGuardInput: (position, state) => ({
        state,
        config: { limit: 0 },
        position,
      }),
    },
  });

  const run = await runGuard('count_limit', 'before_decision', { count: 4 }, {
    onBlock: ({ result, state }) => ({
      allowed: false,
      message: `${result.reason}:${state.count}`,
    }),
  });

  assert.deepEqual(run.update, {
    allowed: false,
    message: 'limit_reached:4',
  });
});
