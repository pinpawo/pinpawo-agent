import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createGuardRunner,
  defineGuard,
  guardBlock,
  guardPass,
  GuardRegistry,
  type GuardRunnerAdapter,
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

// ---------------------------------------------------------------------------
// createGuardRunner adapter factory tests
// ---------------------------------------------------------------------------

test('createGuardRunner delegates to adapter resolveGuardInput and applyResult', async () => {
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

  const adapter: GuardRunnerAdapter<State, Config, Position, Update> = {
    resolveGuardInput: ({ state, position }) => ({
      state,
      config: { limit: 2 },
      position,
    }),
    applyResult: ({ result }) => result.update ?? { allowed: false },
  };

  const runGuard = createGuardRunner({ registry, adapter });

  const { result, update } = await runGuard({
    name: 'count_limit',
    position: 'before_decision',
    state: { count: 3 },
  });

  assert.equal(result.status, 'block');
  assert.deepEqual(update, { allowed: true });
});

test('createGuardRunner passes onBlock callback through to registry.run', async () => {
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

  const adapter: GuardRunnerAdapter<State, Config, Position, Update> = {
    resolveGuardInput: ({ state, position }) => ({
      state,
      config: { limit: 2 },
      position,
    }),
    applyResult: ({ result }) => result.update ?? { allowed: false },
  };

  const runGuard = createGuardRunner({ registry, adapter });

  const { result, update } = await runGuard({
    name: 'count_limit',
    position: 'before_decision',
    state: { count: 3 },
    runOptions: {
      onBlock: ({ guardName, result }) => ({
        allowed: false,
        message: `${guardName}:${result.reason}`,
      }),
    },
  });

  assert.equal(result.status, 'block');
  assert.deepEqual(update, { allowed: false, message: 'count_limit:limit_reached' });
});

test('createGuardRunner returns null update when guard passes and handler returns null', async () => {
  const guard = defineGuard<State, Config, Position, Update>({
    name: 'count_limit',
    positions: ['before_decision'],
    rule: {
      check: () => guardPass(),
    },
    handler: {
      handle: () => null,
    },
  });
  const registry = new GuardRegistry<State, Config, Position, Update>();
  registry.register(guard);

  const adapter: GuardRunnerAdapter<State, Config, Position, Update> = {
    resolveGuardInput: ({ state, position }) => ({
      state,
      config: { limit: 1 },
      position,
    }),
    applyResult: ({ result }) => result.update ?? null,
  };

  const runGuard = createGuardRunner({ registry, adapter });

  const { result, update } = await runGuard({
    name: 'count_limit',
    position: 'before_decision',
    state: { count: 0 },
  });

  assert.equal(result.status, 'pass');
  assert.equal(update, null);
});
