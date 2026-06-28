import assert from 'node:assert/strict';
import test from 'node:test';
import { AIMessage } from '@langchain/core/messages';
import {
  applyOrchestratorGuardEffect,
  createOrchestratorGuardRegistry,
  ORCHESTRATOR_GUARD_NAME,
  ORCHESTRATOR_GUARD_POSITION,
  type OrchestratorGuardConfig,
} from './guardDefinitions';
import { setPinpetMeta } from './messageLanes';
import type { OrchestratorStateType } from './state';
import type { TaskActiveDelegation } from './types';

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

const config: OrchestratorGuardConfig = {
  runIterationLimit: 25,
};

const activeDelegation: TaskActiveDelegation = {
  id: 'd1',
  lane: 'general',
  task: '做点事',
  contextSummary: null,
  transcriptRunId: 'run-1',
  status: 'awaiting_decision',
  resultPreview: null,
};

test('orchestrator guard registry exposes business guards by position', () => {
  const registry = createOrchestratorGuardRegistry();

  assert.deepEqual(
    registry
      .list(ORCHESTRATOR_GUARD_POSITION.DELEGATION_OUTCOME_ITERATION)
      .map((guard) => guard.name),
    [ORCHESTRATOR_GUARD_NAME.RUN_ITERATION_LIMIT],
  );
});

test('user intent guard returns a handoff state patch effect', async () => {
  const registry = createOrchestratorGuardRegistry();
  const effect = await registry.run(ORCHESTRATOR_GUARD_NAME.USER_INTENT_DECISION, {
    state: baseState(),
    config,
    position: ORCHESTRATOR_GUARD_POSITION.USER_INTENT_DECISION,
  });

  assert.deepEqual(applyOrchestratorGuardEffect(effect), {
    canHandoffActiveDelegation: true,
  });
});

test('delegation outcome guard blocks handoff for a limit_reached active delegation', async () => {
  const registry = createOrchestratorGuardRegistry();
  const announce = new AIMessage('limit reached');
  setPinpetMeta(announce, {
    lane: 'general',
    isAnnounce: true,
    completionReason: 'limit_reached',
    runId: 'run-1',
    delegationId: 'd1',
  });
  const state = baseState({
    taskActiveDelegation: activeDelegation,
    messages: [announce],
  });

  const result = registry.check(ORCHESTRATOR_GUARD_NAME.DELEGATION_OUTCOME_DECISION, {
    state,
    config,
    position: ORCHESTRATOR_GUARD_POSITION.DELEGATION_OUTCOME_DECISION,
  });
  assert.equal(result.status, 'block');

  const effect = await registry.run(ORCHESTRATOR_GUARD_NAME.DELEGATION_OUTCOME_DECISION, {
    state,
    config,
    position: ORCHESTRATOR_GUARD_POSITION.DELEGATION_OUTCOME_DECISION,
  });
  assert.deepEqual(applyOrchestratorGuardEffect(effect), {
    canHandoffActiveDelegation: false,
  });
});

test('run iteration limit guard uses resolved config and returns an inline stop patch', async () => {
  const registry = createOrchestratorGuardRegistry();
  const state = baseState({
    taskActiveDelegation: activeDelegation,
    runIterationCount: 5,
  });

  const result = registry.check(ORCHESTRATOR_GUARD_NAME.RUN_ITERATION_LIMIT, {
    state,
    config: { runIterationLimit: 5 },
    position: ORCHESTRATOR_GUARD_POSITION.DELEGATION_OUTCOME_ITERATION,
  });
  assert.equal(result.status, 'block');

  const effect = await registry.run(ORCHESTRATOR_GUARD_NAME.RUN_ITERATION_LIMIT, {
    state,
    config: { runIterationLimit: 5 },
    position: ORCHESTRATOR_GUARD_POSITION.DELEGATION_OUTCOME_ITERATION,
  });
  const patch = applyOrchestratorGuardEffect(effect) as Record<string, unknown>;

  assert.equal(patch.runPendingFinalReply, 'inline');
  assert.equal(patch.runIterationCount, 0);
  assert.equal(patch.runPendingDelegation, null);
  assert.ok(Array.isArray(patch.messages) && patch.messages.length === 1);
});
