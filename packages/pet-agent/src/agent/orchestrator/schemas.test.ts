import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildDelegationOutcomeDecisionOutputInstruction,
  buildDelegationOutcomeDecisionSchema,
  buildCapabilityPlanningDecisionOutputInstruction,
  buildCapabilityPlanningDecisionSchema,
  buildRouteCapabilityLane,
  buildRouteDecisionOutputInstruction,
  buildRouteDecisionSchema,
  buildTaskDecisionOutputInstruction,
  buildTaskDecisionSchema,
  parseRouteLane,
} from './schemas';

test('route decision schema rejects candidate names containing "."', () => {
  assert.throws(
    () => buildRouteDecisionSchema({ capabilityCandidates: [{ name: 'foo.bar' }] }),
    /capability name must not contain '\.'/,
  );
});

test('route decision schema rejects duplicate candidate names', () => {
  assert.throws(
    () => buildRouteDecisionSchema({
      capabilityCandidates: [{ name: 'browser' }, { name: 'browser' }],
    }),
    /duplicate capability name/,
  );
});

test('task decision schema separates task birth from route selection', () => {
  const schema = buildTaskDecisionSchema();
  assert.equal(schema.safeParse({ action: 'answer' }).success, true);
  assert.equal(schema.safeParse({
    action: 'direct_task',
    task: '读取 issue #269 并提炼需求点。',
    context_summary: '用户要求先理解 issue。',
    search_keywords: 'github issue|需求分析',
  }).success, true);
  assert.equal(schema.safeParse({ action: 'direct_task', task: null }).success, false);
  assert.equal(schema.safeParse({ action: 'direct_task', task: '   ' }).success, false);
  assert.equal(schema.safeParse({ action: 'needs_plan' }).success, true);
  assert.equal(schema.safeParse({
    action: 'delegate_capability.browser',
    task: '打开网页',
  }).success, false);
  assert.equal(schema.safeParse({ lane: 'capability.browser' }).success, false);
});

test('task decision schema describes the evidence and execution boundary', () => {
  const instruction = buildTaskDecisionOutputInstruction('jsonMode');
  assert.match(instruction, /answer=基于对话中的已有信息回复/);
  assert.match(instruction, /direct_task=执行一个当前任务/);
  assert.match(instruction, /needs_plan=先规划多个任务/);
});

test('route decision schema owns capability lane enum', () => {
  const schema = buildRouteDecisionSchema({
    capabilityCandidates: [{ name: 'browser' }],
  });
  assert.equal(schema.safeParse({ lane: 'general' }).success, true);
  assert.equal(schema.safeParse({ lane: 'capability.browser' }).success, true);
  assert.equal(schema.safeParse({ lane: 'capability.daily_post' }).success, false);
  assert.equal(schema.safeParse({ action: 'delegate_capability.browser' }).success, false);
});

test('delegation outcome decision schema is verdict-only', () => {
  const schema = buildDelegationOutcomeDecisionSchema();
  assert.equal(schema.safeParse({ outcome: 'continue', gap_note: '缺少测试结果' }).success, true);
  assert.equal(schema.safeParse({ outcome: 'task_done' }).success, false);
  assert.equal(schema.safeParse({ outcome: 'task_done', gap_note: null }).success, true);
  assert.equal(schema.safeParse({ outcome: 'goal_done', gap_note: null }).success, true);
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

  // limit_reached continues legitimately have no new gap; null stays valid.
  const continueWithoutGap = schema.safeParse({ outcome: 'continue', gap_note: null });
  assert.equal(continueWithoutGap.success, true);
  assert.equal(schema.safeParse({ outcome: 'continue' }).success, false);
  assert.equal(schema.safeParse({ outcome: 'continue', gap_note: '   ' }).success, false);

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
});

test('capability planner schema materializes a concrete next task without capability ids', () => {
  const schema = buildCapabilityPlanningDecisionSchema();
  assert.equal(schema.safeParse({
    result: 'next_task',
    remaining_plan: [
      { objective: '根据结论重构 auth', capability_intent: 'code_modification', status: 'deferred' },
    ],
    next_task: { objective: '调查 auth', capability_intent: 'codebase_exploration' },
  }).success, true);
  assert.equal(schema.safeParse({
    result: 'next_task',
    remaining_plan: [],
    next_task: { objective: '调查 auth', capability_intent: 'codebase_exploration' },
  }).success, true);
  assert.equal(schema.safeParse({
    result: 'next_task',
    remaining_plan: [
      { objective: '调查 auth', capability_intent: 'codebase_exploration', status: 'concrete' },
    ],
    next_task: { objective: '调查 auth', capability_intent: 'codebase_exploration' },
  }).success, false);
  assert.equal(schema.safeParse({ result: 'next_task', remaining_plan: [], next_task: null }).success, false);
  assert.equal(schema.safeParse({ result: 'answer', remaining_plan: [] }).success, false);
  assert.equal(schema.safeParse({
    result: 'answer',
    remaining_plan: [{ objective: '调查 auth', capability_intent: 'codebase_exploration', status: 'concrete' }],
    next_task: null,
  }).success, false);
  assert.equal(schema.safeParse({
    result: 'answer',
    remaining_plan: [],
    next_task: { objective: '调查 auth', capability_intent: 'codebase_exploration' },
  }).success, false);
  assert.equal(schema.safeParse({
    result: 'next_task',
    remaining_plan: [{ objective: '调查 auth', capability_intent: '   ', status: 'concrete' }],
    next_task: { objective: '调查 auth', capability_intent: '   ' },
  }).success, false);
  const parsed = schema.parse({
    result: 'answer',
    remaining_plan: [],
    next_task: null,
    capability_id: 'explore',
  });
  assert.equal('capability_id' in parsed, false);
});

test('parseRouteLane splits capability lane names', () => {
  assert.deepEqual(parseRouteLane('capability.browser'), {
    kind: 'capability',
    capabilityName: 'browser',
  });
  assert.deepEqual(parseRouteLane('general'), {
    kind: 'general',
    capabilityName: null,
  });
});

test('buildRouteCapabilityLane composes the prefix correctly', () => {
  assert.equal(buildRouteCapabilityLane('browser'), 'capability.browser');
});

test('decision output instructions add schema shape only for jsonMode', () => {
  const defaultTaskInstruction = buildTaskDecisionOutputInstruction();
  assert.match(defaultTaskInstruction, /structured-output schema/);
  assert.doesNotMatch(defaultTaskInstruction, /JSON Schema/);

  const jsonModeTaskInstruction = buildTaskDecisionOutputInstruction('jsonMode');
  assert.match(jsonModeTaskInstruction, /JSON Schema/);
  assert.match(jsonModeTaskInstruction, /"action"/);
  assert.doesNotMatch(jsonModeTaskInstruction, /"plan_draft"/);

  const jsonModePlannerInstruction = buildCapabilityPlanningDecisionOutputInstruction('jsonMode');
  assert.match(jsonModePlannerInstruction, /result=answer 时为空数组/);
  assert.match(jsonModePlannerInstruction, /"required":\["result","remaining_plan","next_task"\]/);

  const jsonModeRouteInstruction = buildRouteDecisionOutputInstruction({
    capabilityCandidates: [{ name: 'browser' }],
  }, 'jsonMode');
  assert.match(jsonModeRouteInstruction, /"lane"/);
  assert.match(jsonModeRouteInstruction, /capability\.browser/);

  const defaultOutcomeInstruction = buildDelegationOutcomeDecisionOutputInstruction();
  assert.doesNotMatch(defaultOutcomeInstruction, /JSON Schema/);
  const jsonModeOutcomeInstruction = buildDelegationOutcomeDecisionOutputInstruction('jsonMode');
  assert.match(jsonModeOutcomeInstruction, /"outcome"/);
  assert.match(jsonModeOutcomeInstruction, /"gap_note"/);
  assert.match(jsonModeOutcomeInstruction, /"required":\["outcome","gap_note"\]/);
  assert.doesNotMatch(jsonModeOutcomeInstruction, /delegate_capability\.browser/);
});
