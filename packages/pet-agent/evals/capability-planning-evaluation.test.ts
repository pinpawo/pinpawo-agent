import assert from 'node:assert/strict';
import test from 'node:test';
import { AIMessage, HumanMessage } from '@langchain/core/messages';
import {
  buildCapabilityPlanningRecentMessages,
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

test('planner eval preserves the latest ten conversation messages with their roles', () => {
  const messages = Array.from({ length: 12 }, (_, index) => ({
    role: index % 2 === 0 ? 'user' as const : 'assistant' as const,
    content: `message-${index.toString()}`,
  }));
  const projected = buildCapabilityPlanningRecentMessages(messages);

  assert.equal(projected.length, 10);
  assert.equal(String(projected[0]?.content), 'message-2');
  assert.equal(String(projected.at(-1)?.content), 'message-11');
  assert.ok(projected[0] instanceof HumanMessage);
  assert.ok(projected[1] instanceof AIMessage);
});

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
      'future_work_strategy_valid',
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
      result: 'execute_plan',
      nextTask: '探索 auth 模块现有结构和风险',
      capabilityName: 'explore',
      remainingPlan: [{
        capability: 'general',
        task: '撰写一篇与 auth 重构无关的博客',
      }],
    },
    judge: goalJudgeWithFailure('future_work_strategy_valid'),
  });

  assert.equal(
    evaluation.scores.find(({ key }) => key === 'planner_result_correct')?.score,
    1,
  );
  assert.equal(
    evaluation.scores.find(({ key }) => key === 'future_work_strategy_valid')?.score,
    0,
  );
  assert.equal(evaluation.scores.every(({ score }) => score === 1), false);
});
