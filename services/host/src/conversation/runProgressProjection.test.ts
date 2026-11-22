import assert from 'node:assert/strict';
import test from 'node:test';
import { AIMessage, ToolMessage } from '@langchain/core/messages';
import { createCapabilityExecutionMessage } from '@pinpawo/pet-agent/testing';
import { projectRunProgress } from './runProgressProjection';

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

test('latest formal root delivery and pending objective are separate facts of the same active graph run', () => {
  const messages = [...returned('0', 'Previous run private text', older), ...returned('1', 'Earlier finding.'),
    ...returned('2', 'A verified; two sources agree.\n```json\n{"raw":"no"}\n```'),
    ...returned('3', 'Nested result', scope, 'capability:general'),
    new ToolMessage({ name: 'not_a_handoff', tool_call_id: '4', content: 'RAW TOOL OUTPUT' })];
  const plan = { runId: scope.runId, plan: [
    { status: 'completed', objective: 'A' }, { status: 'pending', objective: 'Verify B' },
  ] };
  assert.deepEqual(projectRunProgress({ ...scope, messages, runSupervisorState: plan }, scope), {
    latestDelivery: 'A verified; two sources agree.', pendingObjectives: ['Verify B'],
  });
});

test('a new request never samples an old checkpoint, even if the shorter run ID collides', () => {
  const state = { ...older, messages: returned('1', 'Previous delivery', older),
    runSupervisorState: { runId: older.runId, plan: [{ status: 'pending', objective: 'Old objective' }] } };
  assert.equal(projectRunProgress(state, scope), undefined);
  assert.equal(projectRunProgress({ ...state, runId: scope.runId }, scope), undefined);
  assert.equal(projectRunProgress({ ...state, ...scope }, scope), undefined, 'an adopted previous plan is not this run’s plan');
});

test('returns plan only when no eligible handoff, and withholds credential text without replaying an earlier result', () => {
  const plan = { runId: scope.runId, plan: [{ status: 'pending', objective: 'Check B' }] };
  const messages = [...returned('1', 'Earlier A'), ...returned('2', 'api_key: fake-private-sample')];
  assert.deepEqual(projectRunProgress({ ...scope, messages, runSupervisorState: plan }, scope), { pendingObjectives: ['Check B'] });
  assert.deepEqual(projectRunProgress({ ...scope, messages: [], runSupervisorState: plan }, scope), { pendingObjectives: ['Check B'] });
  assert.equal(projectRunProgress({ ...scope, messages: [] }, scope), undefined);
});

test('bounds prose and removes artifact links and local paths before transport', () => {
  const messages = returned('1', `Results recorded in [proof](artifact://private/123) /Users/t/private.md. ${'z'.repeat(700)}`);
  const progress = projectRunProgress({ ...scope, messages }, scope);
  assert.ok(progress?.latestDelivery);
  assert.equal(progress.latestDelivery.length, 641);
  assert.doesNotMatch(progress.latestDelivery, /artifact:|Users|private\.md|PRIVATE_/);
});
