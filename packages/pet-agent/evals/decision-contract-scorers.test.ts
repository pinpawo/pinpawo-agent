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

test('entry scorer treats textual steps as one task when the execution boundary is shared', () => {
  const testCase = entryDecisionBasicsDataset.cases.find((item) => item.name === 'multiple-actions-one-capability-call');
  assert.ok(testCase);
  assert.equal(testCase.expected.expectedBoundaryCount, 1);
  assert.ok(allPass(scoreEntryDecision({
    mode: 'direct_task',
    task: '读取 package.json 的依赖，运行 npm test，并汇总结果。',
    boundaryCount: 1,
  }, testCase.expected)));
});

test('current taskDecision adapter exposes the missing needs_plan mode', () => {
  assert.equal(adaptTaskDecisionMode('next_task'), 'direct_task');
  assert.notEqual(adaptTaskDecisionMode('next_task'), 'needs_plan');
});

test('capability scorer rejects an unregistered selected capability', () => {
  const testCase = capabilityDecisionBasicsDataset.cases[0];
  assert.ok(testCase);
  const scores = scoreCapabilityDecision({
    selectedLane: 'capability.fabricated',
    candidateNames: testCase.expected.expectedCandidateNames,
  }, testCase.expected, testCase.input.availableCapabilities.map(({ name }) => name));
  assert.equal(scores.find((score) => score.key === 'selected_capability_registered')?.score, 0);
});

test('outcome scorer rejects next-task generation', () => {
  const testCase = outcomeDecisionBasicsDataset.cases[1];
  assert.ok(testCase);
  const scores = scoreOutcomeDecision({ outcome: 'task_done', next_task: '修改 auth 模块' }, testCase.expected);
  assert.equal(scores.find((score) => score.key === 'outcome_ownership_correct')?.score, 0);
});

test('planning datasets cover entry and boundary distributions', () => {
  const modes = new Set(capabilityPlanningBasicsDataset.cases.map((testCase) => testCase.input.mode));
  assert.deepEqual([...modes].sort(), ['boundary', 'entry']);
  assert.ok(capabilityPlanningBasicsDataset.cases.some((testCase) => testCase.expected.rubberStamp));
  assert.ok(capabilityPlanningBasicsDataset.cases.some((testCase) => testCase.expected.planEffect === 'cancelled'));
});

test('planner scorer rejects binding a concrete capability id', () => {
  const testCase = capabilityPlanningBasicsDataset.cases[0];
  assert.ok(testCase);
  const scores = scoreCapabilityPlanning({
    result: testCase.expected.result,
    nextTask: '调查 auth 模块的结构和风险',
    capabilityIntent: testCase.expected.capabilityIntent,
    capabilityId: 'explore',
    remainingPlan: testCase.expected.remainingPlan.map((item) => ({
      objective: item.objectiveTerms.join(' '),
      capabilityIntent: item.capabilityIntent,
      status: item.status,
    })),
  }, testCase.expected, testCase.input);
  assert.equal(scores.find((score) => score.key === 'planner_does_not_bind_capability_id')?.score, 0);
});

test('planner scorer derives cancellation instead of trusting a label', () => {
  const testCase = capabilityPlanningBasicsDataset.cases.find((item) => item.name === 'boundary-cancels-obsolete-task');
  assert.ok(testCase);
  const scores = scoreCapabilityPlanning({
    result: 'answer',
    nextTask: null,
    capabilityIntent: null,
    remainingPlan: testCase.input.remainingPlan ?? [],
  }, testCase.expected, testCase.input);
  assert.equal(scores.find((score) => score.key === 'plan_effect_correct')?.score, 0);
  assert.equal(scores.find((score) => score.key === 'remaining_plan_correct')?.score, 0);
});
