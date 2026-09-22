import { readFixtureDelivery } from '../../../testing/capabilityDelivery';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  materializeDelegation,
} from './briefing';
import {
  getAgentMessageLane,
  getAgentMessageMetadata,
} from '../../messages';


test('delegation materializes one model-only briefing with the stable goal', () => {
  const briefing = materializeDelegation({
    userRequest: '处理 GitHub issue，并保留已有工作。',
    task: '关闭 GitHub Issue #272。',
    briefing: 'Capability intent: GitHub issue 操作',
  });
  const text = String(briefing.content);

  assert.match(text, /^<delegation_briefing role="task_boundary" source="orchestrator">/);
  assert.match(text, /<run_user_request role="goal_context" source="orchestrator_state" trust="read_only">/);
  assert.match(text, /<request>[\s\S]*处理 GitHub issue，并保留已有工作。[\s\S]*<\/request>/);
  assert.match(text, /<task>[\s\S]*关闭 GitHub Issue #272。[\s\S]*<\/task>/);
  assert.match(text, /<briefing>[\s\S]*Capability intent: GitHub issue 操作[\s\S]*<\/briefing>/);
  assert.doesNotMatch(text, /run-1|task-b|capability:github/);
  assert.equal(briefing._getType(), 'human');
  assert.equal(getAgentMessageLane(briefing), null);
  assert.ok(briefing.id);
});

test('delegation XML safely preserves a CDATA terminator in the delegated briefing', () => {
  const briefing = materializeDelegation({
    userRequest: '检查边界。',
    task: '检查边界。',
    briefing: '检查 ]]> 边界。',
  });

  assert.match(String(briefing.content), /检查 \]\]\]\]>\<!\[CDATA\[> 边界。/);
});

test('briefing is invocation input and never becomes lane routing truth', () => {
  const briefing = materializeDelegation({
    userRequest: '完成任务。',
    task: '任务。',
    briefing: 'Complete the task and return verified evidence.',
  });

  assert.equal(getAgentMessageMetadata(briefing).source, 'delegation_briefing');
  assert.equal(getAgentMessageLane(briefing), null);
  assert.equal(readFixtureDelivery(briefing), null);
});
