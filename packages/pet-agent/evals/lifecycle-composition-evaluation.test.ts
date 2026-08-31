import assert from 'node:assert/strict';
import test from 'node:test';
import { AIMessage } from '@langchain/core/messages';
import { setPinpetMeta } from '../src/agent/orchestrator/messageLanes.ts';
import {
  evaluateLifecycleCompositionInvariants,
  lifecycleCompositionGoalAchieved,
  resolveControlledExecutorResult,
} from './lifecycle-composition-evaluation.ts';
import { orchestratorLifecycleCompositionDataset } from './datasets/orchestrator-lifecycle-composition.ts';

test('lifecycle composition cases have stable identities and consume every controlled executor result', () => {
  const ids = orchestratorLifecycleCompositionDataset.cases.map(({ id }) => id);
  assert.equal(new Set(ids).size, ids.length);
  for (const testCase of orchestratorLifecycleCompositionDataset.cases) {
    const executorResultCount = testCase.input.turns.reduce(
      (sum, turn) => sum + turn.executorResults.length,
      0,
    );
    assert.ok(testCase.expected.executorCallRange.min >= 0);
    assert.ok(
      testCase.expected.executorCallRange.max
      >= testCase.expected.executorCallRange.min,
    );
    assert.equal(
      testCase.expected.executorCallRange.max,
      executorResultCount,
      `${testCase.id} must supply every potentially consumed controlled executor result`,
    );
    const criterionIds = testCase.expected.acceptanceCriteria.map(({ id }) => id);
    assert.ok(criterionIds.length > 0);
    assert.equal(new Set(criterionIds).size, criterionIds.length);
  }
});

test('lifecycle composition pass requires semantic goals and mechanical invariants', () => {
  const invariants = evaluateLifecycleCompositionInvariants({
    finalState: {
      messages: [new AIMessage('done')],
      runNextDelegation: null,
      runSupervisorSession: null,
      taskRunContinuation: null,
      taskActiveDelegation: null,
      runIterationCount: 0,
      runLatestDelegationOutcome: null,
    },
    assistantMessageCount: 1,
    executorCallCount: 1,
    expectedExecutorCallRange: { min: 1, max: 1 },
    expectedCheckpointState: 'clean',
  });
  assert.equal(invariants.every(({ passed }) => passed), true);
  assert.equal(lifecycleCompositionGoalAchieved([{
    key: 'goal',
    statement: 'goal',
    evaluator: 'llm-judge',
    score: 1,
    comment: 'met',
  }], invariants), true);
  assert.equal(lifecycleCompositionGoalAchieved([{
    key: 'goal',
    statement: 'goal',
    evaluator: 'llm-judge',
    score: 0,
    comment: 'not met',
  }], invariants), false);
});

test('lifecycle composition cannot pass an exactly-once case without an executor call', () => {
  const invariants = evaluateLifecycleCompositionInvariants({
    finalState: {
      messages: [new AIMessage('looks complete')],
      runNextDelegation: null,
      runSupervisorSession: null,
      taskRunContinuation: null,
      taskActiveDelegation: null,
      runIterationCount: 0,
      runLatestDelegationOutcome: null,
    },
    assistantMessageCount: 1,
    executorCallCount: 0,
    expectedExecutorCallRange: { min: 1, max: 1 },
    expectedCheckpointState: 'clean',
  });
  const executorInvariant = invariants.find(({ id }) => id === 'executor_call_count');
  assert.equal(executorInvariant?.passed, false);
  assert.equal(lifecycleCompositionGoalAchieved([{
    key: 'goal',
    statement: 'goal',
    evaluator: 'llm-judge',
    score: 1,
    comment: 'met',
  }], invariants), false);
});

test('lifecycle composition accepts an isolated resumable checkpoint for required user input', () => {
  const retainedAnnounce = new AIMessage('need staging address and credentials');
  retainedAnnounce.id = 'announce-awaiting-input';
  setPinpetMeta(retainedAnnounce, {
    lane: 'capability:workspace_analysis',
    runId: 'delegation-run-1',
    delegationId: 'delegation-1',
    isAnnounce: true,
  });
  const invariants = evaluateLifecycleCompositionInvariants({
    finalState: {
      messages: [retainedAnnounce],
      runNextDelegation: null,
      runSupervisorSession: null,
      taskRunContinuation: {
        traceId: 'trace-1',
        userRequest: 'check staging deployment',
        activeDelegationId: 'delegation-1',
        remainingPlan: [],
      },
      taskActiveDelegation: {
        id: 'delegation-1',
        lane: 'capability:workspace_analysis',
        task: 'check staging deployment',
        contextSummary: null,
        transcriptRunId: 'delegation-run-1',
        traceId: 'trace-1',
        status: 'awaiting_decision',
        resultPreview: 'need staging address and credentials',
        userRequest: 'check staging deployment',
      },
      runIterationCount: 0,
      runLatestDelegationOutcome: null,
    },
    assistantMessageCount: 1,
    executorCallCount: 1,
    expectedExecutorCallRange: { min: 1, max: 1 },
    expectedCheckpointState: 'awaiting_user_input',
  });

  assert.equal(invariants.every(({ passed }) => passed), true);
});

test('controlled executor results stay scoped to the current user turn', () => {
  const turns = [
    { userMessage: 'first', executorResults: ['first-result'] },
    { userMessage: 'second', executorResults: ['second-result'] },
  ];
  assert.deepEqual(resolveControlledExecutorResult({
    turns,
    latestUserMessage: 'second',
    resultIndex: 0,
  }), {
    turnIndex: 1,
    result: 'second-result',
  });
  assert.deepEqual(resolveControlledExecutorResult({
    turns,
    latestUserMessage: 'second',
    resultIndex: 1,
  }), {
    turnIndex: 1,
    result: null,
  });
});
