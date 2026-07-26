import assert from 'node:assert/strict';
import test from 'node:test';
import { capabilityDecisionBasicsDataset } from './datasets/capability-decision-basics.ts';
import { capabilityPlanningBasicsDataset } from './datasets/capability-planning-basics.ts';
import { entryDecisionBasicsDataset } from './datasets/entry-decision-basics.ts';
import { outcomeDecisionBasicsDataset } from './datasets/outcome-decision-basics.ts';
import {
  adaptTaskDecisionMode,
  scoreCapabilityDecision,
  scoreCapabilityPlanning,
  scoreEntryDecision,
  scoreOutcomeDecision,
} from './decision-contract-scorers.ts';

function allPass(scores: Array<{ score: number }>) {
  return scores.every((score) => score.score === 1);
}

test('entry scorer gates only the structured decision mode', () => {
  const testCase = entryDecisionBasicsDataset.cases.find((item) => item.name === 'multiple-actions-one-capability-call');
  assert.ok(testCase);
  assert.equal(testCase.expected.expectedBoundaryCount, 1);
  const scores = scoreEntryDecision({
    mode: 'direct_task',
  }, testCase.expected);
  assert.deepEqual(scores.map(({ key }) => key), ['entry_mode_correct']);
  assert.ok(allPass(scores));
});

test('entryDecision adapter exposes the planning mode', () => {
  assert.equal(adaptTaskDecisionMode('direct_task'), 'direct_task');
  assert.equal(adaptTaskDecisionMode('needs_plan'), 'needs_plan');
});

test('entryDecision dataset covers the result-availability matrix', () => {
  const ids = entryDecisionBasicsDataset.cases.map((testCase) => testCase.id);
  const names = new Set(entryDecisionBasicsDataset.cases.map((testCase) => testCase.name));
  const modes = new Set(entryDecisionBasicsDataset.cases.map((testCase) => testCase.expected.mode));

  assert.equal(new Set(ids).size, ids.length);
  assert.deepEqual([...modes].sort(), ['answer', 'direct_task', 'needs_plan']);
  assert.ok(names.has('answer-from-explicit-completion-evidence'));
  assert.ok(names.has('answer-from-stable-model-knowledge'));
  assert.ok(names.has('intention-is-not-completion-evidence'));
  assert.ok(names.has('current-local-state-needs-observation'));
  assert.ok(names.has('current-remote-state-needs-lookup'));
  assert.ok(names.has('stale-evidence-needs-refresh'));
  assert.ok(names.has('clarification-before-execution'));
  assert.ok(names.has('calculation-needs-execution'));
});

test('capability scorer gates only the model-owned executor selection', () => {
  const testCase = capabilityDecisionBasicsDataset.cases[0];
  assert.ok(testCase);
  const scores = scoreCapabilityDecision({
    selection: testCase.expected.expectedSelection,
  }, testCase.expected);
  assert.deepEqual(scores.map(({ key }) => key), ['capability_selection_correct']);
  assert.ok(allPass(scores));
});

test('outcome scorer gates only the model-owned verdict', () => {
  const testCase = outcomeDecisionBasicsDataset.cases[1];
  assert.ok(testCase);
  const scores = scoreOutcomeDecision({ outcome: 'task_done' }, testCase.expected);
  assert.deepEqual(scores.map(({ key }) => key), ['outcome_correct']);
  assert.ok(allPass(scores));
});

test('planning datasets cover entry and boundary distributions', () => {
  const modes = new Set(capabilityPlanningBasicsDataset.cases.map((testCase) => testCase.input.mode));
  assert.deepEqual([...modes].sort(), ['boundary', 'entry']);
  assert.ok(capabilityPlanningBasicsDataset.cases.some((testCase) => testCase.expected.rubberStamp));
  assert.ok(capabilityPlanningBasicsDataset.cases.some((testCase) => testCase.expected.planEffect === 'cancelled'));
});

test('planner scorer reconstructs an unchanged plan from next task plus future tail', () => {
  const testCase = capabilityPlanningBasicsDataset.cases.find((item) => item.name === 'boundary-keeps-valid-next-task');
  assert.ok(testCase);
  const materialized = testCase.input.remainingPlan?.[0];
  assert.ok(materialized);
  const scores = scoreCapabilityPlanning({
    result: 'next_task',
    nextTask: materialized.objective,
    capabilityIntent: materialized.capabilityIntent,
    remainingPlan: [],
  }, testCase.expected);
  assert.ok(allPass(scores));
});

test('planner deterministic scorer does not treat capability intent as executor identity', () => {
  const testCase = capabilityPlanningBasicsDataset.cases.find(
    (item) => item.name === 'boundary-keeps-valid-next-task',
  );
  assert.ok(testCase);
  const materialized = testCase.input.remainingPlan?.[0];
  assert.ok(materialized);
  const scores = scoreCapabilityPlanning({
    result: 'next_task',
    nextTask: materialized.objective,
    capabilityIntent: 'deliver a completed document to its intended recipient',
    remainingPlan: [],
  }, testCase.expected);
  assert.ok(allPass(scores));
  assert.deepEqual(
    scores.map(({ key }) => key),
    ['planner_result_correct'],
  );
});

test('planner deterministic scorer can enforce a case-specific future task count', () => {
  const testCase = capabilityPlanningBasicsDataset.cases.find(
    (item) => item.name === 'entry-keeps-investigation-scope',
  );
  assert.ok(testCase);
  const scores = scoreCapabilityPlanning({
    result: 'next_task',
    nextTask: '调查失败测试并形成完整结论',
    capabilityIntent: 'workspace_analysis',
    remainingPlan: [{
      objective: '修复代码',
      capabilityIntent: 'code_change',
    }],
  }, testCase.expected);
  assert.equal(
    scores.find(({ key }) => key === 'remaining_plan_length_correct')?.score,
    0,
  );
});
