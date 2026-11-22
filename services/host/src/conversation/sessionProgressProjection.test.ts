import assert from 'node:assert/strict';
import test from 'node:test';
import { AIMessage, ToolMessage } from '@langchain/core/messages';
import type { AgentPlan } from '@pinpawo/agent-session';
import { createCapabilityExecutionMessage } from '@pinpawo/pet-agent/testing';
import { projectSessionProgress } from './sessionProgressProjection';

const scope = { runId: 'current', taskId: 'current-task' };
const older = { runId: 'older', taskId: 'older-task' };

function returned(n: string, text: string, identity = scope, privateLane?: string) {
  const metadata = { ...identity, lane: privateLane };
  const callId = `call:${n}`;
  const tool = new AIMessage({ content: '', additional_kwargs: { pinpawo: metadata },
    tool_calls: [{ id: callId, name: 'delegate_capability', args: { briefing: 'PRIVATE_BRIEFING' } }] });
  return [tool, createCapabilityExecutionMessage({ callId, metadata,
    execution: { planItemId: n, capability: 'general', task: 'PRIVATE_TITLE', delegationId: n, briefing: 'PRIVATE_BRIEFING' },
    result: { status: 'returned', deliverables: [{ uri: 'artifact://private/x' }],
      delivery: { id: n, task: 'PRIVATE_TITLE', text, scope: { ...identity, lane: 'capability:general', delegationId: n } } },
  })];
}

const plan = (...items: Array<[AgentPlan['items'][number]['status'], string]>): AgentPlan => ({
  items: items.map(([status, task], index) => ({ id: String(index), capability: 'general', task, status })),
});

test('latest formal root delivery and recorded plan are distinct Session evidence', () => {
  const messages = [...returned('0', 'Previous delivery', older), ...returned('1', 'Earlier finding.'),
    ...returned('2', 'A verified; two sources agree.\n```json\n{"raw":"no"}\n```'),
    ...returned('3', 'Nested result', scope, 'capability:general'),
    new ToolMessage({ name: 'not_a_handoff', tool_call_id: '4', content: 'RAW TOOL OUTPUT' })];
  assert.deepEqual(projectSessionProgress(messages, plan(['completed', 'A'], ['active', 'Verify B'])), {
    latestDelivery: 'A verified; two sources agree.', recordedPendingObjectives: ['Verify B'],
  });
});

test('uses the Session’s previous Root delivery until the Session records a newer one', () => {
  const previous = returned('1', 'Previous delivery', older);
  const previousPlan = plan(['pending', 'Previous objective']);
  assert.deepEqual(projectSessionProgress(previous, previousPlan), {
    latestDelivery: 'Previous delivery', recordedPendingObjectives: ['Previous objective'],
  });
  const requested = new AIMessage({ content: '', additional_kwargs: { pinpawo: scope },
    tool_calls: [{ id: 'unreturned', name: 'delegate_capability', args: { briefing: 'NOT RETURNED' } }] });
  assert.deepEqual(projectSessionProgress([...previous, requested], null), { latestDelivery: 'Previous delivery' });
  assert.deepEqual(projectSessionProgress([...previous, ...returned('2', 'New delivery')], null), { latestDelivery: 'New delivery' });
});

test('returns recorded plan when no eligible handoff and withholds secret text without replaying an earlier result', () => {
  const pending = plan(['pending', 'Check B']);
  const messages = [...returned('1', 'Earlier A'), ...returned('2', 'api_key: fake-private-sample')];
  assert.deepEqual(projectSessionProgress(messages, pending), { recordedPendingObjectives: ['Check B'] });
  assert.deepEqual(projectSessionProgress([], pending), { recordedPendingObjectives: ['Check B'] });
  assert.equal(projectSessionProgress([], null), undefined);
});

test('bounds prose and removes artifact links and local paths before transport', () => {
  const messages = returned('1', `Results recorded in [proof](artifact://private/123) /Users/t/private.md. ${'z'.repeat(700)}`);
  const progress = projectSessionProgress(messages, null);
  assert.ok(progress?.latestDelivery);
  assert.equal(progress.latestDelivery.length, 641);
  assert.doesNotMatch(progress.latestDelivery, /artifact:|Users|private\.md|PRIVATE_/);
});
