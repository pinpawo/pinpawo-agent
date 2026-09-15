import assert from 'node:assert/strict';
import test from 'node:test';
import { AIMessage, ToolMessage } from '@langchain/core/messages';
import { currentPlansEqual, projectCurrentPlan } from './currentPlanProjection';

function execution(taskId: string, capability: string, lane?: string) {
  const metadata = { runId: 'run', traceId: 'trace', lane };
  return [new AIMessage({ content: '', additional_kwargs: { pinpawo: metadata },
    tool_calls: [{ id: `call:${taskId}`, name: 'delegate_capability', args: { briefing: 'Execute the current objective.' } }] }),
  new ToolMessage({ name: 'delegate_capability', tool_call_id: `call:${taskId}`, content: 'Delivery',
    additional_kwargs: { pinpawo: metadata },
    artifact: { taskId, capability, task: 'Work', delegationId: 'delegation', mode: 'initial', briefing: 'Plan' } })];
}

test('projects business progress and derives active execution from Root messages', () => {
  const plan = projectCurrentPlan({ runSupervisorState: { goal: 'Inspect and verify.', plan: [
    { id: '1', capability: 'general', objective: 'Understand', status: 'completed' },
    { id: '2', capability: 'explore', objective: 'Inspect', status: 'pending' },
    { id: '3', capability: 'browser', objective: 'Verify', status: 'pending' },
  ] }, messages: [...execution('2', 'explore')] });
  assert.deepEqual(plan?.items.map((task) => [task.id, task.status]), [['1', 'completed'], ['2', 'active'], ['3', 'pending']]);
  assert.equal(projectCurrentPlan({ runSupervisorState: { plan: [
    { id: '1', capability: 'general', objective: 'Review delivery', status: 'pending' },
  ] }, messages: [...execution('1', 'general')] })?.items[0].status, 'active');
});

test('completed A and pending B survive the gap and remain displayable from the saved snapshot', () => {
  const state = { runSupervisorState: { goal: 'Prepare and publish.', plan: [
    { id: '1', capability: 'general', objective: 'Prepare', status: 'completed' },
    { id: '2', capability: 'general', objective: 'Publish', status: 'pending' },
  ] } };
  assert.deepEqual(projectCurrentPlan(state)?.items.map((task) => task.status), ['completed', 'pending']);
  assert.deepEqual(projectCurrentPlan({ ...state, runId: 'next-run' }), projectCurrentPlan(state));
});

test('a pending plan renders without an active execution and empty states clear the panel', () => {
  assert.equal(projectCurrentPlan({ runSupervisorState: { plan: [
    { id: '1', capability: 'general', objective: 'Draft', status: 'pending' },
  ] } })?.items.length, 1);
  for (const state of [{}, null, { runSupervisorState: { plan: [] } }]) assert.equal(projectCurrentPlan(state), null);
});

test('keeps identifiers exact and normalizes display text', () => {
  assert.deepEqual(projectCurrentPlan({ runSupervisorState: { plan: [
    { id: ' id ', capability: ' explore ', objective: ' Inspect ', status: 'pending' },
  ] }, messages: [...execution(' id ', 'explore')] })?.items, [{ id: ' id ', capability: 'explore', task: 'Inspect', status: 'active' }]);
});

test('excludes superseded and malformed tasks and ignores private execution messages', () => {
  const plan = projectCurrentPlan({ runSupervisorState: { plan: [
    { id: 'old', capability: 'general', objective: 'Old task', status: 'superseded' },
    { id: 'new', capability: 'writer', objective: 'New task', status: 'pending' },
    { id: 'invalid', task: 'Missing capability', status: 'pending' },
    { id: 'unknown', capability: 'general', objective: 'Bad status', status: 'finished' },
  ] }, messages: [null, { content: 'This is not a plan.' }, ...execution('new', 'writer', 'supervisor'), ...execution('new', 'general')] });
  assert.deepEqual(plan?.items, [{ id: 'new', capability: 'writer', task: 'New task', status: 'pending' }]);
});

test('compares plans structurally to avoid duplicate transport events', () => {
  const plan = { items: [{ id: '1', capability: 'general', task: 'Plan', status: 'active' as const }] };
  assert.equal(currentPlansEqual(plan, { items: [{ ...plan.items[0] }] }), true);
  assert.equal(currentPlansEqual(plan, null), false);
});

test('native pending handoff marks only the current task active, including interrupted execution', () => {
  const state = { runId: 'run', runSupervisorState: { plan: [
    { id: 'a', capability: 'general', objective: 'Inspect', status: 'pending' },
    { id: 'b', capability: 'general', objective: 'Report', status: 'pending' },
  ] }, messages: [execution('a', 'general')[0]] };
  assert.deepEqual(projectCurrentPlan(state)?.items.map(item => item.status), ['active', 'pending']);
  assert.deepEqual(projectCurrentPlan({ ...state, runId: 'other' })?.items.map(item => item.status), ['pending', 'pending']);
});
