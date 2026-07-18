import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  buildContinuationBriefingMessage,
  buildDelegationBriefingMessage,
  buildDelegationPlanMessage,
  isDelegationBriefingMessage,
} from './delegationBriefing';
import {
  getMessageDelegationId,
  getMessageIsAnnounce,
  getMessageHandoffSource,
  getMessageLane,
  getMessageTurnId,
  getPinpetMeta,
} from './messageLanes';

test('delegation briefing is compact and scoped to its delegation lane', () => {
  const briefing = buildDelegationBriefingMessage({
    lane: 'capability:github',
    runId: 'run-1',
    delegationId: 'task-b',
    task: '关闭 GitHub Issue #272。',
    contextSummary: 'Capability intent: GitHub issue 操作',
  });

  const text = String(briefing.content);
  assert.match(text, /【委派简报】/);
  assert.match(text, /当前任务：关闭 GitHub Issue #272。/);
  assert.match(text, /必要上下文：Capability intent: GitHub issue 操作/);
  assert.doesNotMatch(text, /执行器|计划进度|剩余计划|执行边界/);
  assert.equal(getMessageLane(briefing), 'capability:github');
  assert.ok(briefing.id);
});

test('delegation briefing omits empty sections', () => {
  const briefing = buildDelegationBriefingMessage({
    lane: 'general',
    runId: 'run-1',
    delegationId: 'task-a',
    task: '检查仓库状态。',
    contextSummary: null,
  });

  const text = String(briefing.content);
  assert.doesNotMatch(text, /必要上下文/);
  assert.doesNotMatch(text, /计划进度/);
  assert.doesNotMatch(text, /剩余计划/);
});

test('continuation briefing keeps the task and carries the gap note', () => {
  const withGap = buildContinuationBriefingMessage({
    lane: 'capability:github',
    runId: 'run-1',
    delegationId: 'task-a',
    task: '关闭 GitHub Issue #272。',
    gapNote: '未验证 issue 状态，请确认已关闭。',
  });
  assert.match(String(withGap.content), /【委派简报·继续】/);
  assert.match(String(withGap.content), /任务仍然是：关闭 GitHub Issue #272。/);
  assert.match(String(withGap.content), /上轮缺口：未验证 issue 状态/);
  assert.equal(getMessageLane(withGap), 'capability:github');

  const withoutGap = buildContinuationBriefingMessage({
    lane: 'capability:github',
    runId: 'run-1',
    delegationId: 'task-a',
    task: '关闭 GitHub Issue #272。',
    gapNote: null,
  });
  assert.doesNotMatch(String(withoutGap.content), /上轮缺口/);
});

test('briefing metadata is observability-only and never reads as announce or handoff', () => {
  const briefing = buildDelegationBriefingMessage({
    lane: 'general',
    runId: 'run-9',
    delegationId: 'task-9',
    task: '任务。',
    contextSummary: null,
  });

  assert.equal(isDelegationBriefingMessage(briefing), true);
  assert.equal(getPinpetMeta(briefing).synthetic, true);
  assert.equal(getMessageTurnId(briefing), 'run-9');
  assert.equal(getMessageDelegationId(briefing), 'task-9');
  assert.equal(getMessageLane(briefing), 'general');
  // Never mistaken for the upward direction (announce / handoff copy).
  assert.equal(getMessageIsAnnounce(briefing), false);
  assert.equal(getMessageHandoffSource(briefing), null);
});

test('delegation plan is a concise ordinary main AIMessage', () => {
  const plan = buildDelegationPlanMessage({
    runId: 'run-1',
    delegationId: 'task-a',
    task: '检查仓库状态。',
  });

  assert.equal(getMessageLane(plan), null);
  assert.match(String(plan.content), /接下来我会先处理这项任务：检查仓库状态。/);
  assert.doesNotMatch(String(plan.content), /【委派简报】|执行边界|capability:/);
  assert.equal(getPinpetMeta(plan).source, 'delegation_plan');
});
