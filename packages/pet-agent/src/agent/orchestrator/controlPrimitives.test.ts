import assert from 'node:assert/strict';
import test from 'node:test';
import type { RunnableConfig } from '@langchain/core/runnables';
import {
  asDecisionNode,
  ORCHESTRATOR_RECURSION_LIMIT,
  type OrchestratorControlContext,
  type OrchestratorDecision,
} from './controlPrimitives';
import type { OrchestratorStateType } from './state';

const STATE = { runIterationCount: 3 } as unknown as OrchestratorStateType;

function buildContext(runnableConfig?: RunnableConfig): OrchestratorControlContext {
  return { runnableConfig, orchestratorMaxIterations: 25 };
}

test('asDecisionNode awaits the decision and forwards its patch', async () => {
  const decision: OrchestratorDecision = async (_state, ctx) => {
    assert.equal(ctx.orchestratorMaxIterations, 25);
    return { runPendingDelegation: null };
  };

  const node = asDecisionNode(decision, buildContext);
  const patch = await node(STATE);

  assert.deepEqual(patch, { runPendingDelegation: null });
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
