import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  buildContinuationBriefingMessage,
  buildDelegationBriefingMessage,
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

test('delegation briefing renders task, context, progress and remaining plan from state', () => {
  const briefing = buildDelegationBriefingMessage({
    lane: 'capability:github',
    runId: 'run-1',
    delegationId: 'task-b',
    task: '关闭 GitHub Issue #272。',
    contextSummary: 'Capability intent: GitHub issue 操作',
    runDelegationSummaries: [
      { id: 'task-a', lane: 'general', task: '删除 packages/goat 目录。', status: 'completed', resultPreview: '目录已删除，包含 12 个文件。' },
      { id: 'task-b', lane: 'capability:github', task: '关闭 GitHub Issue #272。', status: 'pending', resultPreview: null },
    ],
    remainingPlan: [
      { objective: '汇总执行结果。', capabilityIntent: 'summary', status: 'deferred' },
    ],
  });

  const text = String(briefing.content);
  assert.match(text, /【委派简报】/);
  assert.match(text, /执行器：capability:github/);
  assert.match(text, /当前任务：关闭 GitHub Issue #272。/);
  assert.match(text, /必要上下文：Capability intent: GitHub issue 操作/);
  assert.match(text, /\[已完成\] 删除 packages\/goat 目录。/);
  assert.match(text, /1\. 汇总执行结果。（summary）/);
  assert.match(text, /只执行当前任务/);
  // The current delegation appears as the current-task line, not in progress.
  assert.doesNotMatch(text, /\[待执行\] 关闭 GitHub Issue #272。/);
  // resultPreview never repeats into the briefing — announce copies carry it.
  assert.doesNotMatch(text, /目录已删除/);
});

test('delegation briefing omits empty sections', () => {
  const briefing = buildDelegationBriefingMessage({
    lane: 'general',
    runId: 'run-1',
    delegationId: 'task-a',
    task: '检查仓库状态。',
    contextSummary: null,
    runDelegationSummaries: [
      { id: 'task-a', lane: 'general', task: '检查仓库状态。', status: 'pending', resultPreview: null },
    ],
    remainingPlan: [],
  });

  const text = String(briefing.content);
  assert.doesNotMatch(text, /必要上下文/);
  assert.doesNotMatch(text, /计划进度/);
  assert.doesNotMatch(text, /剩余计划/);
});

test('continuation briefing keeps the task and carries the gap note', () => {
  const withGap = buildContinuationBriefingMessage({
    runId: 'run-1',
    delegationId: 'task-a',
    task: '关闭 GitHub Issue #272。',
    gapNote: '未验证 issue 状态，请确认已关闭。',
  });
  assert.match(String(withGap.content), /【委派简报·继续】/);
  assert.match(String(withGap.content), /任务仍然是：关闭 GitHub Issue #272。/);
  assert.match(String(withGap.content), /上轮缺口：未验证 issue 状态/);
  assert.match(String(withGap.content), /不要重新开始/);

  const withoutGap = buildContinuationBriefingMessage({
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
    runDelegationSummaries: [],
    remainingPlan: [],
  });

  assert.equal(isDelegationBriefingMessage(briefing), true);
  assert.equal(getPinpetMeta(briefing).synthetic, true);
  assert.equal(getMessageTurnId(briefing), 'run-9');
  assert.equal(getMessageDelegationId(briefing), 'task-9');
  // Unlaned: flows to subagents via laneMessages and stays out of lane wipes.
  assert.equal(getMessageLane(briefing), null);
  // Never mistaken for the upward direction (announce / handoff copy).
  assert.equal(getMessageIsAnnounce(briefing), false);
  assert.equal(getMessageHandoffSource(briefing), null);
});
