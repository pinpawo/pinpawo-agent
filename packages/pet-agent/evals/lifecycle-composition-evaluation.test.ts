import assert from 'node:assert/strict';
import test from 'node:test';
import { AIMessage } from '@langchain/core/messages';
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
    assert.equal(
      testCase.expected.executorCallCount,
      executorResultCount,
      `${testCase.id} must account for every controlled executor result`,
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
      runPendingTask: null,
      runCapabilityPlan: [],
      taskActiveDelegation: null,
      runIterationCount: 0,
      runLatestDelegationOutcome: null,
    },
    assistantMessageCount: 1,
    executorCallCount: 1,
    expectedExecutorCallCount: 1,
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
