import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  isDelegationBriefingMessage,
  materializeDelegation,
} from './delegationBriefing';
import {
  getMessageDelegationId,
  getMessageIsAnnounce,
  getMessageHandoffSource,
  getMessageLane,
  getMessageTurnId,
  getPinpetMeta,
} from './messageLanes';

test('initial delegation materializes a concise main plan and scoped XML briefing', () => {
  const materialized = materializeDelegation({
    mode: 'initial',
    lane: 'capability:github',
    runId: 'run-1',
    delegationId: 'task-b',
    task: '关闭 GitHub Issue #272。',
    essentialContext: 'Capability intent: GitHub issue 操作',
  });
  const [briefing] = materialized.laneMessages;
  const [plan] = materialized.mainMessages;
  const text = String(briefing.content);

  assert.equal(materialized.mainMessages.length, 1);
  assert.equal(getMessageLane(plan), null);
  assert.match(String(plan.content), /接下来我会先处理这项任务：关闭 GitHub Issue #272。/);
  assert.doesNotMatch(String(plan.content), /delegation_briefing|执行边界|capability:/);
  assert.equal(getPinpetMeta(plan).source, 'delegation_plan');

  assert.match(text, /^<delegation_briefing role="task_boundary" source="orchestrator" mode="initial">/);
  assert.match(text, /<task>[\s\S]*关闭 GitHub Issue #272。[\s\S]*<\/task>/);
  assert.match(text, /<essential_context>[\s\S]*Capability intent: GitHub issue 操作[\s\S]*<\/essential_context>/);
  assert.doesNotMatch(text, /run-1|task-b|capability:github/);
  assert.equal(getMessageLane(briefing), 'capability:github');
  assert.ok(briefing.id);
});

test('initial delegation omits empty essential context', () => {
  const [briefing] = materializeDelegation({
    mode: 'initial',
    lane: 'capability:general',
    runId: 'run-1',
    delegationId: 'task-a',
    task: '检查仓库状态。',
    essentialContext: null,
  }).laneMessages;

  assert.doesNotMatch(String(briefing.content), /<essential_context>/);
});

test('continuation delegation carries task and optional gap note without a new main plan', () => {
  const withGap = materializeDelegation({
    mode: 'continue',
    lane: 'capability:github',
    runId: 'run-1',
    delegationId: 'task-a',
    task: '关闭 GitHub Issue #272。',
    gapNote: '未验证 issue 状态，请确认已关闭。',
  });
  const [briefing] = withGap.laneMessages;
  const text = String(briefing.content);

  assert.deepEqual(withGap.mainMessages, []);
  assert.match(text, /^<delegation_briefing role="task_boundary" source="orchestrator" mode="continue">/);
  assert.match(text, /<task>[\s\S]*关闭 GitHub Issue #272。[\s\S]*<\/task>/);
  assert.match(text, /<gap_note>[\s\S]*未验证 issue 状态，请确认已关闭。[\s\S]*<\/gap_note>/);
  assert.equal(getMessageLane(briefing), 'capability:github');

  const [withoutGap] = materializeDelegation({
    mode: 'continue',
    lane: 'capability:github',
    runId: 'run-1',
    delegationId: 'task-a',
    task: '关闭 GitHub Issue #272。',
    gapNote: null,
  }).laneMessages;
  assert.doesNotMatch(String(withoutGap.content), /<gap_note>/);
});

test('delegation XML safely preserves a CDATA terminator in task text', () => {
  const [briefing] = materializeDelegation({
    mode: 'initial',
    lane: 'capability:general',
    runId: 'run-1',
    delegationId: 'task-a',
    task: '检查 ]]> 边界。',
    essentialContext: null,
  }).laneMessages;

  assert.match(String(briefing.content), /检查 \]\]\]\]>\<!\[CDATA\[> 边界。/);
});

test('briefing metadata is routing truth and never reads as announce or handoff', () => {
  const [briefing] = materializeDelegation({
    mode: 'initial',
    lane: 'capability:general',
    runId: 'run-9',
    delegationId: 'task-9',
    task: '任务。',
    essentialContext: null,
  }).laneMessages;

  assert.equal(isDelegationBriefingMessage(briefing), true);
  assert.equal(getPinpetMeta(briefing).synthetic, true);
  assert.equal(getMessageTurnId(briefing), 'run-9');
  assert.equal(getMessageDelegationId(briefing), 'task-9');
  assert.equal(getMessageLane(briefing), 'capability:general');
  assert.equal(getMessageIsAnnounce(briefing), false);
  assert.equal(getMessageHandoffSource(briefing), null);
});
