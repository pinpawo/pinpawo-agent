import assert from 'node:assert/strict';
import test from 'node:test';
import type { RunnableConfig } from '@langchain/core/runnables';
import {
  asDecisionNode,
  asGuardNode,
  ORCHESTRATOR_RECURSION_LIMIT,
  type OrchestratorControlContext,
  type OrchestratorDecision,
  type OrchestratorGuard,
} from './controlPrimitives';
import type { OrchestratorStateType } from './state';

const STATE = { runIterationCount: 3 } as unknown as OrchestratorStateType;

function buildContext(runnableConfig?: RunnableConfig): OrchestratorControlContext {
  return { runnableConfig, orchestratorMaxIterations: 25 };
}

test('asGuardNode passes state + built context to the guard and returns its patch', async () => {
  let seen: { state: OrchestratorStateType; ctx: OrchestratorControlContext } | null = null;
  const guard: OrchestratorGuard = (state, ctx) => {
    seen = { state, ctx };
    return { runPendingFinalReply: 'inline' };
  };

  const node = asGuardNode(guard, buildContext);
  const cfg = { configurable: { thread_id: 't1' } } as RunnableConfig;
  const patch = await node(STATE, cfg);

  assert.deepEqual(patch, { runPendingFinalReply: 'inline' });
  assert.equal(seen!.state, STATE);
  assert.equal(seen!.ctx.orchestratorMaxIterations, 25);
  assert.equal(seen!.ctx.runnableConfig, cfg);
});

test('asDecisionNode awaits the decision and forwards its patch', async () => {
  const decision: OrchestratorDecision = async (_state, ctx) => {
    assert.equal(ctx.orchestratorMaxIterations, 25);
    return { runPendingDelegation: null };
  };

  const node = asDecisionNode(decision, buildContext);
  const patch = await node(STATE);

  assert.deepEqual(patch, { runPendingDelegation: null });
});

test('a guard reading orchestratorMaxIterations from ctx (not closure) works', async () => {
  // Mirrors runIterationLimitGuard's use of ctx.orchestratorMaxIterations.
  const guard: OrchestratorGuard = (state, ctx) =>
    state.runIterationCount >= ctx.orchestratorMaxIterations
      ? { runPendingFinalReply: 'inline' }
      : { runPendingFinalReply: null };

  const underLimit = asGuardNode(guard, () => ({ orchestratorMaxIterations: 25 }));
  assert.deepEqual(await underLimit(STATE), { runPendingFinalReply: null });

  const atLimit = asGuardNode(guard, () => ({ orchestratorMaxIterations: 3 }));
  assert.deepEqual(await atLimit(STATE), { runPendingFinalReply: 'inline' });
});

test('ORCHESTRATOR_RECURSION_LIMIT comfortably exceeds a healthy run', () => {
  // The hard breaker is a flat last-resort value, not derived. It must sit well
  // above what a healthy run consumes: the soft guard's default 25 delegations,
  // each walking a handful of graph nodes (~100 nodes total). 200 leaves headroom.
  assert.ok(
    ORCHESTRATOR_RECURSION_LIMIT > 100,
    `recursion limit ${ORCHESTRATOR_RECURSION_LIMIT} must exceed a healthy run's node count`,
  );
});
