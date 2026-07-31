import assert from 'node:assert/strict';
import test from 'node:test';
import { capabilityPlanningBasicsDataset } from './datasets/capability-planning-basics.ts';
import { entryDecisionBasicsDataset } from './datasets/entry-decision-basics.ts';
import { outcomeDecisionBasicsDataset } from './datasets/outcome-decision-basics.ts';
import {
  scoreCapabilityPlanning,
  scoreEntryDecision,
  scoreOutcomeDecision,
} from './decision-contract-scorers.ts';

function allPass(scores: Array<{ score: number }>) {
  return scores.every((score) => score.score === 1);
}

test('entry scorer gates only result availability', () => {
  const testCase = entryDecisionBasicsDataset.cases.find(
    (item) => item.name === 'current-local-state-needs-observation',
  );
  assert.ok(testCase);
  const scores = scoreEntryDecision({
    mode: 'needs_plan',
  }, testCase.expected);
  assert.deepEqual(scores.map(({ key }) => key), ['entry_mode_correct']);
  assert.ok(allPass(scores));
});

test('entryDecision dataset covers the result-availability matrix', () => {
  const ids = entryDecisionBasicsDataset.cases.map((testCase) => testCase.id);
  const names = new Set(entryDecisionBasicsDataset.cases.map((testCase) => testCase.name));
  const modes = new Set(entryDecisionBasicsDataset.cases.map((testCase) => testCase.expected.mode));

  assert.equal(new Set(ids).size, ids.length);
  assert.deepEqual([...modes].sort(), ['answer', 'needs_plan']);
  assert.ok(names.has('answer-from-explicit-completion-evidence'));
  assert.ok(names.has('answer-from-stable-model-knowledge'));
  assert.ok(names.has('intention-is-not-completion-evidence'));
  assert.ok(names.has('current-local-state-needs-observation'));
  assert.ok(names.has('current-remote-state-needs-lookup'));
  assert.ok(names.has('stale-evidence-needs-refresh'));
  assert.ok(names.has('clarification-before-execution'));
  assert.ok(names.has('calculation-needs-execution'));
});

test('outcome scorer gates only the model-owned verdict', () => {
  const testCase = outcomeDecisionBasicsDataset.cases[1];
  assert.ok(testCase);
  const scores = scoreOutcomeDecision({ outcome: 'task_done' }, testCase.expected);
  assert.deepEqual(scores.map(({ key }) => key), ['outcome_correct']);
  assert.ok(allPass(scores));
});

test('outcome dataset covers advisory future-plan terminal distinctions', () => {
  assert.ok(outcomeDecisionBasicsDataset.cases.some((testCase) =>
    testCase.expected.outcome === 'task_done'
    && (testCase.input.remainingPlan?.length ?? 0) > 0));
  assert.ok(outcomeDecisionBasicsDataset.cases.some((testCase) =>
    testCase.expected.outcome === 'goal_done'
    && (testCase.input.remainingPlan?.length ?? 0) === 0));
  assert.ok(outcomeDecisionBasicsDataset.cases.some((testCase) =>
    testCase.expected.outcome === 'goal_done'
    && (testCase.input.remainingPlan?.length ?? 0) > 0));
});

test('planning datasets cover entry and boundary distributions', () => {
  const modes = new Set(capabilityPlanningBasicsDataset.cases.map((testCase) => testCase.input.mode));
  assert.deepEqual([...modes].sort(), ['boundary', 'entry']);
  assert.ok(capabilityPlanningBasicsDataset.cases.some((testCase) => testCase.expected.rubberStamp));
  assert.ok(capabilityPlanningBasicsDataset.cases.some(
    (testCase) => testCase.expected.capabilityName === 'general',
  ));
});

test('planner scorer enforces the mandatory General fallback', () => {
  const testCase = capabilityPlanningBasicsDataset.cases.find(
    (item) => item.name === 'entry-uses-general-for-unmatched-work',
  );
  assert.ok(testCase);
  const scores = scoreCapabilityPlanning({
    result: 'plan',
    nextTask: '处理普通工作区任务并返回执行结果',
    capabilityName: 'general',
    remainingPlan: [],
  }, testCase.expected);
  assert.equal(
    scores.find(({ key }) => key === 'planner_capability_correct')?.score,
    1,
  );
});

test('planner scorer reconstructs an unchanged plan from next task plus future tail', () => {
  const testCase = capabilityPlanningBasicsDataset.cases.find((item) => item.name === 'boundary-keeps-valid-next-task');
  assert.ok(testCase);
  const materialized = testCase.input.remainingPlan?.[0];
  assert.ok(materialized);
  const scores = scoreCapabilityPlanning({
    result: 'plan',
    nextTask: materialized.task,
    capabilityName: materialized.capability,
    remainingPlan: [],
  }, testCase.expected);
  assert.ok(allPass(scores));
});

test('planner deterministic scorer treats Capability as executor identity', () => {
  const testCase = capabilityPlanningBasicsDataset.cases.find(
    (item) => item.name === 'boundary-keeps-valid-next-task',
  );
  assert.ok(testCase);
  const materialized = testCase.input.remainingPlan?.[0];
  assert.ok(materialized);
  const scores = scoreCapabilityPlanning({
    result: 'plan',
    nextTask: materialized.task,
    capabilityName: 'general',
    remainingPlan: [],
  }, testCase.expected);
  assert.equal(
    scores.find(({ key }) => key === 'planner_capability_correct')?.score,
    0,
  );
});

test('planner deterministic scorer can enforce a case-specific future task count', () => {
  const testCase = capabilityPlanningBasicsDataset.cases.find(
    (item) => item.name === 'entry-keeps-investigation-scope',
  );
  assert.ok(testCase);
  const scores = scoreCapabilityPlanning({
    result: 'plan',
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
