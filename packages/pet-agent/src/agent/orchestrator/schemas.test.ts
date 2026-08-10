import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildEntryDecisionOutputInstruction,
  buildEntryDecisionSchema,
} from './schemas';
import {
  USER_GOAL_CONTEXT_MAX_CHARS,
  USER_GOAL_OBJECTIVE_MAX_CHARS,
} from './capabilityPlanner/runner';

test('entry decision schema owns only the result-availability gate', () => {
  const schema = buildEntryDecisionSchema();
  assert.equal(schema.safeParse({ action: 'answer' }).success, true);
  assert.equal(schema.safeParse({
    action: 'needs_plan',
    planner_objective: '检查 issue #269 并总结。',
  }).success, true);
  assert.equal(schema.safeParse({ action: 'needs_plan' }).success, false);
  assert.equal(schema.safeParse({
    action: 'needs_plan',
    planner_objective: 'x'.repeat(USER_GOAL_OBJECTIVE_MAX_CHARS + 1),
  }).success, false);
  assert.equal(schema.safeParse({
    action: 'needs_plan',
    planner_objective: '执行当前任务。',
    planner_context: 'x'.repeat(USER_GOAL_CONTEXT_MAX_CHARS + 1),
  }).success, false);
  assert.equal(schema.safeParse({
    action: 'direct_task',
    task: '读取 issue #269 并提炼需求点。',
    context_summary: '用户要求先理解 issue。',
  }).success, false);
  assert.equal(schema.safeParse({
    action: 'delegate_capability.browser',
    task: '打开网页',
  }).success, false);
  assert.equal(schema.safeParse({ lane: 'capability.browser' }).success, false);
});

test('decision output instructions add schema shape only for jsonMode', () => {
  const defaultEntryInstruction = buildEntryDecisionOutputInstruction();
  assert.match(defaultEntryInstruction, /structured-output schema/);
  assert.doesNotMatch(defaultEntryInstruction, /JSON Schema/);

  const jsonModeEntryInstruction = buildEntryDecisionOutputInstruction('jsonMode');
  assert.match(jsonModeEntryInstruction, /JSON Schema/);
  assert.doesNotMatch(jsonModeEntryInstruction, /JSON 输出示例/);
  assert.match(jsonModeEntryInstruction, /"action"/);
  assert.doesNotMatch(jsonModeEntryInstruction, /"plan_draft"/);

});
