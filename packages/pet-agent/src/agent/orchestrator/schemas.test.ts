import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildDelegationOutcomeDecisionOutputInstruction,
  buildDelegationOutcomeDecisionSchema,
  buildRouteCapabilityLane,
  buildRouteDecisionSchema,
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
    action: 'next_task',
    task: '读取 issue #269 并提炼需求点。',
    context_summary: '用户要求先理解 issue。',
    search_keywords: 'github issue|需求分析',
    plan_draft: ['读取 issue', '检索代码', '汇总结论'],
  }).success, true);
  assert.equal(schema.safeParse({
    action: 'next_task',
    task: '读取 issue #269 并提炼需求点。',
    plan_draft: ['1', '2', '3', '4', '5', '6'],
  }).success, false);
  assert.equal(schema.safeParse({
    action: 'delegate_capability.browser',
    task: '打开网页',
  }).success, false);
  assert.equal(schema.safeParse({ lane: 'capability.browser' }).success, false);
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
  assert.equal(schema.safeParse({ outcome: 'task_done' }).success, true);
  assert.equal(schema.safeParse({ outcome: 'goal_done', gap_note: null }).success, true);
  assert.equal(schema.safeParse({ outcome: 'next_task' }).success, false);
  assert.equal(schema.safeParse({ action: 'answer' }).success, false);

  const parsed = schema.safeParse({
    outcome: 'task_done',
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

test('delegation outcome output instruction does not expose task or capability routing fields', () => {
  const instruction = buildDelegationOutcomeDecisionOutputInstruction();
  assert.match(instruction, /outcome/);
  assert.match(instruction, /gap_note/);
  assert.doesNotMatch(instruction, /delegate_capability\.browser/);
  assert.doesNotMatch(instruction, /context_summary 时/);
});
