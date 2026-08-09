import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildDelegationOutcomeDecisionOutputInstruction,
  buildDelegationOutcomeDecisionSchema,
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

test('delegation outcome decision schema is verdict-only', () => {
  const schema = buildDelegationOutcomeDecisionSchema();
  assert.equal(schema.safeParse({ outcome: 'continue', gap_note: '缺少测试结果' }).success, true);
  const taskDoneWithoutGap = schema.safeParse({ outcome: 'task_done' });
  assert.equal(taskDoneWithoutGap.success, true);
  if (taskDoneWithoutGap.success) {
    assert.equal(taskDoneWithoutGap.data.gap_note, null);
  }
  assert.equal(schema.safeParse({ outcome: 'task_done', gap_note: null }).success, true);
  assert.equal(schema.safeParse({ outcome: 'goal_done', gap_note: null }).success, true);
  assert.equal(schema.safeParse({ outcome: 'user_input_required', gap_note: null }).success, true);
  assert.equal(schema.safeParse({ outcome: 'next_task' }).success, false);
  assert.equal(schema.safeParse({ action: 'answer' }).success, false);

  const parsed = schema.safeParse({
    outcome: 'task_done',
    gap_note: null,
    task: 't',
    context_summary: 'c',
    search_keywords: 'k',
    lane: 'capability.browser',
    capability: 'browser',
  });
  assert.equal(parsed.success, true);
  if (parsed.success) {
    assert.equal('task' in parsed.data, false);
    assert.equal('context_summary' in parsed.data, false);
    assert.equal('search_keywords' in parsed.data, false);
    assert.equal('lane' in parsed.data, false);
    assert.equal('capability' in parsed.data, false);
  }
});

test('delegation outcome schema keeps gap_note on continue and strips it elsewhere', () => {
  const schema = buildDelegationOutcomeDecisionSchema();

  const continueWithGap = schema.safeParse({ outcome: 'continue', gap_note: '未验证 issue 状态。' });
  assert.equal(continueWithGap.success, true);
  if (continueWithGap.success) {
    assert.equal(continueWithGap.data.gap_note, '未验证 issue 状态。');
  }

  // limit_reached continues legitimately have no new gap; every empty input
  // shape normalizes to null.
  const continueWithoutGap = schema.safeParse({ outcome: 'continue' });
  assert.equal(continueWithoutGap.success, true);
  if (continueWithoutGap.success) {
    assert.equal(continueWithoutGap.data.gap_note, null);
  }
  const continueWithBlankGap = schema.safeParse({ outcome: 'continue', gap_note: '   ' });
  assert.equal(continueWithBlankGap.success, true);
  if (continueWithBlankGap.success) {
    assert.equal(continueWithBlankGap.data.gap_note, null);
  }

  // Stray gap_note on a terminal outcome is harmless model noise: normalized
  // away instead of failing the run (autoRepair defaults to zero retries).
  const taskDoneWithGap = schema.safeParse({ outcome: 'task_done', gap_note: '多余的缺口说明' });
  assert.equal(taskDoneWithGap.success, true);
  if (taskDoneWithGap.success) {
    assert.equal(taskDoneWithGap.data.gap_note, null);
  }

  const goalDoneWithGap = schema.safeParse({ outcome: 'goal_done', gap_note: '多余的缺口说明' });
  assert.equal(goalDoneWithGap.success, true);
  if (goalDoneWithGap.success) {
    assert.equal(goalDoneWithGap.data.gap_note, null);
  }

  const userInputRequiredWithGap = schema.safeParse({
    outcome: 'user_input_required',
    gap_note: '多余的缺口说明',
  });
  assert.equal(userInputRequiredWithGap.success, true);
  if (userInputRequiredWithGap.success) {
    assert.equal(userInputRequiredWithGap.data.gap_note, null);
  }
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

  const defaultOutcomeInstruction = buildDelegationOutcomeDecisionOutputInstruction();
  assert.doesNotMatch(defaultOutcomeInstruction, /JSON Schema/);
  const jsonModeOutcomeInstruction = buildDelegationOutcomeDecisionOutputInstruction('jsonMode');
  assert.doesNotMatch(jsonModeOutcomeInstruction, /JSON 输出示例/);
  assert.match(jsonModeOutcomeInstruction, /"outcome"/);
  assert.match(jsonModeOutcomeInstruction, /"gap_note"/);
  assert.match(jsonModeOutcomeInstruction, /"required":\["outcome"\]/);
  assert.doesNotMatch(jsonModeOutcomeInstruction, /"required":\["outcome","gap_note"\]/);
  assert.doesNotMatch(jsonModeOutcomeInstruction, /delegate_capability\.browser/);
});
