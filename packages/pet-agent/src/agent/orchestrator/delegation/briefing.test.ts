import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  materializeDelegation,
} from './briefing';
import {
  getAgentMessageLane,
  getAgentMessageMetadata,
} from '../../messages';
import {
  getDelegationAnnounce,
} from '.';

test('initial delegation materializes one model-only briefing with the stable goal', () => {
  const briefing = materializeDelegation({
    mode: 'initial',
    userRequest: '处理 GitHub issue，并保留已有工作。',
    task: '关闭 GitHub Issue #272。',
    briefing: 'Capability intent: GitHub issue 操作',
  });
  const text = String(briefing.content);

  assert.match(text, /^<delegation_briefing role="task_boundary" source="orchestrator" mode="initial">/);
  assert.match(text, /<run_user_request role="goal_context" source="orchestrator_state" trust="read_only">/);
  assert.match(text, /<request>[\s\S]*处理 GitHub issue，并保留已有工作。[\s\S]*<\/request>/);
  assert.match(text, /<task>[\s\S]*关闭 GitHub Issue #272。[\s\S]*<\/task>/);
  assert.match(text, /<briefing>[\s\S]*Capability intent: GitHub issue 操作[\s\S]*<\/briefing>/);
  assert.doesNotMatch(text, /run-1|task-b|capability:github/);
  assert.equal(briefing._getType(), 'human');
  assert.equal(getAgentMessageLane(briefing), null);
  assert.ok(briefing.id);
});

test('continuation delegation carries task and the same briefing field', () => {
  const briefing = materializeDelegation({
    mode: 'continue',
    userRequest: '完成 GitHub issue 操作。',
    task: '关闭 GitHub Issue #272。',
    briefing: '未验证 issue 状态，请确认已关闭。',
  });
  const text = String(briefing.content);

  assert.match(text, /^<delegation_briefing role="task_boundary" source="orchestrator" mode="continue">/);
  assert.match(text, /<task>[\s\S]*关闭 GitHub Issue #272。[\s\S]*<\/task>/);
  assert.match(text, /<briefing>[\s\S]*未验证 issue 状态，请确认已关闭。[\s\S]*<\/briefing>/);
  assert.equal(getAgentMessageLane(briefing), null);


});

test('delegation XML safely preserves a CDATA terminator in the delegated briefing', () => {
  const briefing = materializeDelegation({
    mode: 'initial',
    userRequest: '检查边界。',
    task: '检查边界。',
    briefing: '检查 ]]> 边界。',
  });

  assert.match(String(briefing.content), /检查 \]\]\]\]>\<!\[CDATA\[> 边界。/);
});

test('briefing is invocation input and never becomes lane routing truth', () => {
  const briefing = materializeDelegation({
    mode: 'initial',
    userRequest: '完成任务。',
    task: '任务。',
    briefing: 'Complete the task and return verified evidence.',
  });

  assert.equal(getAgentMessageMetadata(briefing).source, 'delegation_briefing');
  assert.equal(getAgentMessageLane(briefing), null);
  assert.equal(getDelegationAnnounce(briefing), null);
});
