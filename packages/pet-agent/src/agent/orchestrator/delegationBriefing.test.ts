import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  isDelegationBriefingMessage,
  isDelegationStartedMessage,
  materializeDelegation,
  materializeDelegationStarted,
} from './delegationBriefing';
import {
  getMessageDelegationId,
  getMessageIsAnnounce,
  getMessageHandoffSource,
  getMessageLane,
  getMessageTranscriptRunId,
  getPinpetMeta,
} from './messageLanes';

test('initial delegation materializes one canonical start and one scoped briefing', () => {
  const materialized = materializeDelegation({
    mode: 'initial',
    lane: 'capability:github',
    transcriptRunId: 'run-1',
    delegationId: 'task-b',
    task: '关闭 GitHub Issue #272。',
    essentialContext: 'Capability intent: GitHub issue 操作',
  });
  const [briefing] = materialized.laneMessages;
  const text = String(briefing.content);

  assert.equal(materialized.mainMessages.length, 1);
  assert.equal(isDelegationStartedMessage(materialized.mainMessages[0]), true);
  assert.match(text, /^<delegation_briefing role="task_boundary" source="orchestrator" mode="initial">/);
  assert.match(text, /<task>[\s\S]*关闭 GitHub Issue #272。[\s\S]*<\/task>/);
  assert.match(text, /<essential_context>[\s\S]*Capability intent: GitHub issue 操作[\s\S]*<\/essential_context>/);
  assert.doesNotMatch(text, /run-1|task-b|capability:github/);
  assert.equal(getMessageLane(briefing), 'capability:github');
  assert.ok(briefing.id);
});

test('delegation start is a stable canonical lifecycle record', () => {
  const spec = {
    lane: 'capability:github' as const,
    transcriptRunId: 'run-1',
    delegationId: 'task-b',
    task: '关闭 GitHub Issue #272。',
  };
  const first = materializeDelegationStarted(spec);
  const replayed = materializeDelegationStarted(spec);

  assert.equal(first.id, replayed.id);
  assert.equal(isDelegationStartedMessage(first), true);
  assert.equal(getMessageLane(first), null);
  assert.equal(getMessageTranscriptRunId(first), 'run-1');
  assert.equal(getMessageDelegationId(first), 'task-b');
  assert.match(String(first.content), /关闭 GitHub Issue #272。/);
  assert.equal(getPinpetMeta(first).task, spec.task);
  assert.notEqual(getPinpetMeta(first).synthetic, true);
});

test('initial delegation omits empty essential context', () => {
  const [briefing] = materializeDelegation({
    mode: 'initial',
    lane: 'capability:general',
    transcriptRunId: 'run-1',
    delegationId: 'task-a',
    task: '检查仓库状态。',
    essentialContext: null,
  }).laneMessages;

  assert.doesNotMatch(String(briefing.content), /<essential_context>/);
});

test('continuation delegation carries task and optional gap note', () => {
  const withGap = materializeDelegation({
    mode: 'continue',
    lane: 'capability:github',
    transcriptRunId: 'run-1',
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
    transcriptRunId: 'run-1',
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
    transcriptRunId: 'run-1',
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
    transcriptRunId: 'run-9',
    delegationId: 'task-9',
    task: '任务。',
    essentialContext: null,
  }).laneMessages;

  assert.equal(isDelegationBriefingMessage(briefing), true);
  assert.equal(getPinpetMeta(briefing).synthetic, true);
  assert.equal(getMessageTranscriptRunId(briefing), 'run-9');
  assert.equal(getMessageDelegationId(briefing), 'task-9');
  assert.equal(getMessageLane(briefing), 'capability:general');
  assert.equal(getMessageIsAnnounce(briefing), false);
  assert.equal(getMessageHandoffSource(briefing), null);
});
