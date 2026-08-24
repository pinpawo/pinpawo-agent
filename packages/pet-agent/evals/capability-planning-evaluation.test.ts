import assert from 'node:assert/strict';
import test from 'node:test';
import { AIMessage, HumanMessage } from '@langchain/core/messages';
import {
  buildCapabilityPlanningHistoryMessages,
  buildCapabilityPlanningMessages,
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

test('planner eval preserves the complete conversation with message roles', () => {
  const messages = Array.from({ length: 12 }, (_, index) => ({
    role: index % 2 === 0 ? 'user' as const : 'assistant' as const,
    content: `message-${index.toString()}`,
  }));
  const projected = buildCapabilityPlanningMessages(messages);

  assert.equal(projected.length, 12);
  assert.equal(String(projected[0]?.content), 'message-0');
  assert.equal(String(projected.at(-1)?.content), 'message-11');
  assert.ok(projected[0] instanceof HumanMessage);
  assert.ok(projected[1] instanceof AIMessage);
});

test('boundary eval history does not duplicate the current lane announce', () => {
  const boundaryCases = capabilityPlanningBasicsDataset.cases.filter(
    ({ input }) => input.mode === 'boundary' && input.latestAnnounce,
  );
  assert.ok(boundaryCases.length > 0);
  for (const testCase of boundaryCases) {
    const projected = buildCapabilityPlanningHistoryMessages(testCase.input);
    assert.equal(
      projected.filter((message) =>
        String(message.content).trim() === testCase.input.latestAnnounce?.trim(),
      ).length,
      0,
      testCase.name,
    );
  }
});

test('boundary planning cases identify the active Capability explicitly', () => {
  const boundaryCases = capabilityPlanningBasicsDataset.cases.filter(
    ({ input }) => input.mode === 'boundary',
  );
  assert.ok(boundaryCases.length > 0);
  for (const testCase of boundaryCases) {
    assert.ok(testCase.input.activeCapability, testCase.name);
    assert.ok(
      testCase.input.capabilityRegistry.some((entry) =>
        entry.split(':', 1)[0]?.trim() === testCase.input.activeCapability),
      `${testCase.name}: ${testCase.input.activeCapability ?? '(missing)'}`,
    );
  }
});

test('entry planning distinguishes verifiable facts from user-owned choices', () => {
  const verifiableFact = capabilityPlanningBasicsDataset.cases.find(
    ({ name }) => name === 'entry-verifies-latest-main-instead-of-requesting-user-input',
  );
  const userOwnedChoice = capabilityPlanningBasicsDataset.cases.find(
    ({ name }) => name === 'entry-asks-for-user-owned-deployment-target',
  );
  assert.equal(verifiableFact?.expected.result, 'execute_plan');
  assert.equal(userOwnedChoice?.expected.result, 'user_input_required');
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

test('planner materializes requested recommendation work before asking for confirmation', () => {
  const testCase = capabilityPlanningBasicsDataset.cases.find(
    ({ name }) => name === 'entry-recommends-before-requesting-confirmation',
  );
  assert.ok(testCase);
  assert.equal(testCase.expected.result, 'execute_plan');
  assert.equal(testCase.expected.capabilityName, 'general');
  assert.ok(
    buildCapabilityPlanningGoalContract(testCase.expected).acceptanceCriteria.length > 0,
  );
});

test('trace-derived latest-main verification requires execution rather than user input', () => {
  const testCase = capabilityPlanningBasicsDataset.cases.find(
    ({ name }) => name === 'entry-verifies-latest-main-instead-of-requesting-user-input',
  );
  assert.ok(testCase);
  assert.equal(testCase.expected.result, 'execute_plan');
  assert.equal(testCase.expected.capabilityName, 'general');
  assert.equal(testCase.expected.exactRemainingPlanLength, 0);
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
