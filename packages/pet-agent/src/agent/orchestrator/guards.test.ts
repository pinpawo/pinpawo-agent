import assert from 'node:assert/strict';
import test from 'node:test';
import type { OrchestratorControlContext } from './controlPrimitives';
import { createOrchestratorGuards, readLegacyTaskActiveDelegation } from './guards';
import type { OrchestratorStateType } from './state';
import type { OrchestratorInvokeOptions } from './types';

function ctx(orchestratorMaxIterations = 25): OrchestratorControlContext {
  return { orchestratorMaxIterations };
}

const noInvokeOptions = () => ({}) as OrchestratorInvokeOptions;

function baseState(over: Partial<OrchestratorStateType> = {}): OrchestratorStateType {
  return {
    messages: [],
    runDelegations: [],
    runIterationCount: 0,
    taskActiveDelegation: null,
    runId: 'run-1',
    ...over,
  } as unknown as OrchestratorStateType;
}

const activeDelegation = {
  id: 'd1',
  lane: 'general' as const,
  task: '做点事',
  contextSummary: null,
  transcriptRunId: 'run-1',
  status: 'awaiting_decision' as const,
  resultPreview: null,
};

test('userIntentDecisionGuard always allows handoff', () => {
  const { userIntentDecisionGuard } = createOrchestratorGuards({ getInvokeOptions: noInvokeOptions });
  assert.deepEqual(userIntentDecisionGuard(baseState(), ctx()), { canHandoffActiveDelegation: true });
});

test('delegationOutcomeDecisionGuard allows handoff when there is no active delegation', () => {
  const { delegationOutcomeDecisionGuard } = createOrchestratorGuards({ getInvokeOptions: noInvokeOptions });
  assert.deepEqual(
    delegationOutcomeDecisionGuard(baseState(), ctx()),
    { canHandoffActiveDelegation: true },
  );
});

test('runIterationLimitGuard passes below the limit, blocks at the limit', () => {
  const { runIterationLimitGuard } = createOrchestratorGuards({ getInvokeOptions: noInvokeOptions });

  // No active delegation -> always pass (clears pending reply).
  assert.deepEqual(runIterationLimitGuard(baseState(), ctx()), { runPendingFinalReply: null });

  // Active delegation, under limit -> pass.
  const under = runIterationLimitGuard(
    baseState({ taskActiveDelegation: activeDelegation, runIterationCount: 3 }),
    ctx(25),
  );
  assert.deepEqual(under, { runPendingFinalReply: null });

  // Active delegation, at limit -> block (emit message, route inline, reset count).
  const atLimit = runIterationLimitGuard(
    baseState({ taskActiveDelegation: activeDelegation, runIterationCount: 25 }),
    ctx(25),
  ) as Record<string, unknown>;
  assert.equal(atLimit.runPendingFinalReply, 'inline');
  assert.equal(atLimit.runIterationCount, 0);
  assert.equal(atLimit.runPendingDelegation, null);
  assert.ok(Array.isArray(atLimit.messages) && (atLimit.messages as unknown[]).length === 1);
});

test('runIterationLimitGuard honors an invoke-time maxRunIterations override', () => {
  const { runIterationLimitGuard } = createOrchestratorGuards({
    getInvokeOptions: () => ({ maxRunIterations: 5 }) as OrchestratorInvokeOptions,
  });
  // count 5 >= override 5 -> block, even though ctx default is 25.
  const result = runIterationLimitGuard(
    baseState({ taskActiveDelegation: activeDelegation, runIterationCount: 5 }),
    ctx(25),
  ) as Record<string, unknown>;
  assert.equal(result.runPendingFinalReply, 'inline');
});

test('readLegacyTaskActiveDelegation picks the latest progress/completed delegation', () => {
  assert.equal(readLegacyTaskActiveDelegation(baseState()), null);

  const state = baseState({
    runDelegations: [
      { id: 'a', lane: 'general', task: 't1', status: 'completed', resultPreview: 'r1' },
      { id: 'b', lane: 'general', task: 't2', status: 'progress', resultPreview: 'r2' },
    ] as unknown as OrchestratorStateType['runDelegations'],
  });
  const legacy = readLegacyTaskActiveDelegation(state);
  assert.equal(legacy?.id, 'b');
  assert.equal(legacy?.status, 'awaiting_decision');
});
