import assert from 'node:assert/strict';
import test from 'node:test';
import { capabilityPlanningBasicsDataset } from './datasets/capability-planning-basics.ts';
import {
  scoreCapabilityPlanning,
} from './decision-contract-scorers.ts';

function allPass(scores: Array<{ score: number }>) {
  return scores.every((score) => score.score === 1);
}

test('planning datasets cover entry and boundary distributions', () => {
  const modes = new Set(capabilityPlanningBasicsDataset.cases.map((testCase) => testCase.input.mode));
  assert.deepEqual([...modes].sort(), ['boundary', 'entry']);
  assert.ok(capabilityPlanningBasicsDataset.cases.some((testCase) => testCase.expected.rubberStamp));
  assert.ok(capabilityPlanningBasicsDataset.cases.some(
    (testCase) => testCase.expected.capabilityName === 'general',
  ));
  assert.ok(capabilityPlanningBasicsDataset.cases.some(
    (testCase) => testCase.expected.result === 'unavailable',
  ));
});

test('an exhausted boundary plan can continue autonomous work or report a real capability block', () => {
  const exhaustedBoundaryCases = capabilityPlanningBasicsDataset.cases.filter(
    (testCase) => testCase.input.mode === 'boundary'
      && (testCase.input.remainingPlan ?? []).length === 0,
  );
  const results = new Set(exhaustedBoundaryCases.map((testCase) => testCase.expected.result));
  assert.ok(results.has('advance_plan'));
  assert.ok(results.has('continue_current'));
  assert.ok(results.has('goal_done'));
  assert.ok(results.has('user_input_required'));
  assert.ok(results.has('unavailable'));
});

test('supervisor scorer enforces the mandatory General default candidate', () => {
  const testCase = capabilityPlanningBasicsDataset.cases.find(
    (item) => item.name === 'entry-uses-general-for-unmatched-work',
  );
  assert.ok(testCase);
  const scores = scoreCapabilityPlanning({
    result: 'execute_plan',
    nextTask: '处理普通工作区任务并返回执行结果',
    capabilityName: 'general',
    remainingPlan: [],
  }, testCase.expected);
  assert.equal(
    scores.find(({ key }) => key === 'planner_capability_correct')?.score,
    1,
  );
});

test('supervisor scorer reconstructs an unchanged plan from next task plus future tail', () => {
  const testCase = capabilityPlanningBasicsDataset.cases.find((item) => item.name === 'boundary-keeps-valid-next-task');
  assert.ok(testCase);
  const materialized = testCase.input.remainingPlan?.[0];
  assert.ok(materialized);
  const scores = scoreCapabilityPlanning({
    result: 'advance_plan',
    nextTask: materialized.task,
    capabilityName: materialized.capability,
    remainingPlan: [],
  }, testCase.expected);
  assert.ok(allPass(scores));
});

test('supervisor deterministic scorer treats Capability as executor identity', () => {
  const testCase = capabilityPlanningBasicsDataset.cases.find(
    (item) => item.name === 'boundary-keeps-valid-next-task',
  );
  assert.ok(testCase);
  const materialized = testCase.input.remainingPlan?.[0];
  assert.ok(materialized);
  const scores = scoreCapabilityPlanning({
    result: 'advance_plan',
    nextTask: materialized.task,
    capabilityName: 'general',
    remainingPlan: [],
  }, testCase.expected);
  assert.equal(
    scores.find(({ key }) => key === 'planner_capability_correct')?.score,
    0,
  );
});

test('supervisor deterministic scorer can enforce a case-specific future task count', () => {
  const testCase = capabilityPlanningBasicsDataset.cases.find(
    (item) => item.name === 'entry-keeps-investigation-scope',
  );
  assert.ok(testCase);
  const scores = scoreCapabilityPlanning({
    result: 'execute_plan',
    nextTask: '调查失败测试并形成完整结论',
    capabilityName: 'workspace_analysis',
    remainingPlan: [{
      capability: 'code_change',
      task: '修复代码',
    }],
  }, testCase.expected);
  assert.equal(
    scores.find(({ key }) => key === 'remaining_plan_length_correct')?.score,
    0,
  );
});
