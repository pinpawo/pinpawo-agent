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

function textData(xml: string, tag: string) {
  const open = xml.indexOf(`<${tag}>`);
  const close = xml.indexOf(`</${tag}>`, open);
  assert.ok(open >= 0 && close > open, `missing ${tag} data`);
  const block = xml.slice(open, close);
  const dataStart = block.indexOf('<![CDATA[') + '<![CDATA['.length;
  const dataEnd = block.lastIndexOf(']]>');
  assert.ok(dataStart >= '<![CDATA['.length && dataEnd > dataStart, `missing ${tag} CDATA`);
  const data = block.slice(dataStart, dataEnd);
  return data.slice(data.indexOf('\n') + 1, data.lastIndexOf('\n')).replaceAll(']]]]><![CDATA[>', ']]>');
}

test('continuation context sits outside the unchanged briefing and carries actual prior identities', () => {
  const original = '  Preserve the original "]]>" diagnostic.\nVerify ticket-173 without rewriting the request.\n';
  const spec = { userRequest: 'Inspect and verify.', task: 'Verify the evidence.', briefing: original };
  const initial = materializeDelegation(spec);
  assert.equal(initial.text.includes('<continuation '), false);
  assert.equal(textData(initial.text, 'briefing'), original);
  for (const continuation of [
    { delegationId: 'previous-delegation-42', deliveryId: 'previous-delivery-42' },
    { delegationId: 'previous-delegation-43', deliveryId: 'previous-delivery-43' },
  ]) {
    const resumed = materializeDelegation({ ...spec, continuation });
    assert.equal(textData(resumed.text, 'briefing'), original);
    assert.equal(textData(resumed.text, 'task'), spec.task);
    assert.equal(textData(resumed.text, 'previous_delegation_id'), continuation.delegationId);
    assert.equal(textData(resumed.text, 'previous_delivery_id'), continuation.deliveryId);
    assert.equal(resumed.text.split('<continuation source="runtime">').length - 1, 1);
    const continuationStart = resumed.text.indexOf('<continuation source="runtime">');
    const continuationEnd = resumed.text.indexOf('</continuation>', continuationStart);
    const briefingStart = resumed.text.indexOf('<briefing>');
    const briefingEnd = resumed.text.indexOf('</briefing>');
    assert.ok(continuationEnd < briefingStart || continuationStart > briefingEnd,
      'runtime continuation context cannot replace or become part of the reusable briefing');
    assert.equal(resumed._getType(), 'human');
    assert.equal(getAgentMessageMetadata(resumed).source, 'delegation_briefing');
  }
});

test('a continuation without a prior delivery does not create an invented delivery reference', () => {
  const message = materializeDelegation({
    userRequest: 'Read the report.', task: 'Read the report.', briefing: 'Read the source and report the actual result.',
    continuation: { delegationId: 'stopped-before-delivery', deliveryId: null },
  });
  assert.equal(textData(message.text, 'previous_delegation_id'), 'stopped-before-delivery');
  assert.equal(message.text.includes('<previous_delivery_id>'), false);
  assert.equal(message.text.split('<briefing>').length - 1, 1);
});
