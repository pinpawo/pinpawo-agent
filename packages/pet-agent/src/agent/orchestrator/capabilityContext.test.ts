import assert from 'node:assert/strict';
import test from 'node:test';
import { AIMessage, HumanMessage } from '@langchain/core/messages';
import {
  RUN_USER_REQUEST_CONTEXT_SOURCE,
  buildRunUserRequestContextMessage,
  withRunUserRequestContext,
} from './capabilityContext';
import { materializeDelegation } from './delegationBriefing';
import { getPinpetMeta } from './messageLanes';

test('run request context is synthetic task data with explicit provenance', () => {
  const message = buildRunUserRequestContextMessage(
    '完成仓库修复。\n\n保留此前已确认的文件修改。',
  );

  assert.equal(message._getType(), 'ai');
  assert.equal(getPinpetMeta(message).source, RUN_USER_REQUEST_CONTEXT_SOURCE);
  assert.equal(getPinpetMeta(message).synthetic, true);
  assert.match(String(message.content), /<run_user_request role="task_boundary"/);
  assert.match(String(message.content), /source="orchestrator_state" trust="read_only"/);
  assert.match(String(message.content), /保留此前已确认的文件修改/);
});

test('Capability context preserves full evidence and inserts one goal before the latest briefing', () => {
  const mainUser = new HumanMessage('先检查仓库。');
  const acceptedHandoff = new AIMessage('已修改 packages/a.ts 和 packages/b.ts。');
  const [initialBriefing] = materializeDelegation({
    mode: 'initial',
    lane: 'capability:general',
    transcriptRunId: 'run-1',
    delegationId: 'task-1',
    task: '检查修改后的类型错误。',
    essentialContext: null,
  }).laneMessages;
  const privateProgress = new AIMessage('已经检查 packages/a.ts。');
  const [continuationBriefing] = materializeDelegation({
    mode: 'continue',
    lane: 'capability:general',
    transcriptRunId: 'run-1',
    delegationId: 'task-1',
    task: '继续检查 packages/b.ts。',
    gapNote: null,
  }).laneMessages;
  const original = [
    mainUser,
    acceptedHandoff,
    initialBriefing,
    privateProgress,
    continuationBriefing,
  ];

  const projected = withRunUserRequestContext(
    original,
    '完成仓库检查并修复剩余类型错误。',
  );
  const goalContexts = projected.filter((message) =>
    getPinpetMeta(message).source === RUN_USER_REQUEST_CONTEXT_SOURCE);

  assert.equal(goalContexts.length, 1);
  assert.equal(projected.length, original.length + 1);
  assert.deepEqual(projected.slice(0, -2), original.slice(0, -1));
  assert.equal(projected.at(-2), goalContexts[0]);
  assert.equal(projected.at(-1), continuationBriefing);
  assert.equal(projected.includes(mainUser), true);
  assert.equal(projected.includes(acceptedHandoff), true);
  assert.equal(projected.includes(initialBriefing), true);
  assert.equal(projected.includes(privateProgress), true);

  const refreshed = withRunUserRequestContext(
    projected,
    '完成仓库检查并修复剩余类型错误。',
  );
  assert.equal(
    refreshed.filter((message) =>
      getPinpetMeta(message).source === RUN_USER_REQUEST_CONTEXT_SOURCE).length,
    1,
  );
  assert.equal(refreshed.length, projected.length);
  assert.equal(refreshed.at(-1), continuationBriefing);
});
