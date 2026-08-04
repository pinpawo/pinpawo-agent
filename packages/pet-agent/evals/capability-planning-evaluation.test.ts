import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildCapabilityPlanningGoalContract,
  evaluateCapabilityPlanningOutput,
} from './capability-planning-evaluation.ts';
import { capabilityPlanningBasicsDataset } from './datasets/capability-planning-basics.ts';

function goalJudgeWithFailure(failedCriterion: string) {
  return {
    model: {
      withStructuredOutput: () => ({
        invoke: async (messages: Array<{ content: unknown }>) => {
          const input = JSON.parse(String(messages.at(-1)?.content)) as {
            acceptanceCriteria: Array<{ id: string }>;
          };
          return {
            criteria: Object.fromEntries(input.acceptanceCriteria.map(({ id }) => [id, {
              met: id !== failedCriterion,
              reason: id === failedCriterion ? 'future plan does not preserve the goal' : 'criterion met',
            }])),
            summary: 'one semantic criterion failed',
          };
        },
      }),
    } as never,
  };
}

test('planner goal contract keeps semantic plan checks outside the deterministic result score', () => {
  const testCase = capabilityPlanningBasicsDataset.cases.find(
    ({ name }) => name === 'entry-explore-then-implementation',
  );
  assert.ok(testCase);
  assert.deepEqual(
    buildCapabilityPlanningGoalContract(testCase.expected).acceptanceCriteria.map(({ id }) => id),
    [
      'materialized_task_correct',
      'current_capability_selection_correct',
      'task_boundaries_justified',
      'remaining_plan_objectives_correct',
      'remaining_capability_selections_correct',
    ],
  );
});

test('planner goal contract evaluates an expected empty future plan', () => {
  const testCase = capabilityPlanningBasicsDataset.cases.find(
    ({ name }) => name === 'entry-keeps-investigation-scope',
  );
  assert.ok(testCase);
  const criterion = buildCapabilityPlanningGoalContract(testCase.expected)
    .acceptanceCriteria
    .find(({ id }) => id === 'remaining_plan_objectives_correct');
  assert.ok(criterion);
  assert.match(criterion.statement, /remaining plan is empty/i);
});

test('planner return-to-Answer is evaluated as a structured terminal result', () => {
  const testCase = capabilityPlanningBasicsDataset.cases.find(
    ({ name }) => name === 'entry-returns-to-answer-before-execution',
  );
  assert.ok(testCase);
  assert.deepEqual(
    buildCapabilityPlanningGoalContract(testCase.expected).acceptanceCriteria,
    [],
  );
});

test('planner goal evaluation rejects a semantically wrong plan with the correct result', async () => {
  const testCase = capabilityPlanningBasicsDataset.cases.find(
    ({ name }) => name === 'entry-explore-then-implementation',
  );
  assert.ok(testCase);
  const evaluation = await evaluateCapabilityPlanningOutput({
    input: testCase.input,
    expected: testCase.expected,
    output: {
      result: 'plan',
      nextTask: '探索 auth 模块现有结构和风险',
      capabilityName: 'explore',
      remainingPlan: [{
        capability: 'general',
        task: '撰写一篇与 auth 重构无关的博客',
      }],
    },
    judge: goalJudgeWithFailure('remaining_plan_objectives_correct'),
  });

  assert.equal(
    evaluation.scores.find(({ key }) => key === 'planner_result_correct')?.score,
    1,
  );
  assert.equal(
    evaluation.scores.find(({ key }) => key === 'remaining_plan_objectives_correct')?.score,
    0,
  );
  assert.equal(evaluation.scores.every(({ score }) => score === 1), false);
});
