import assert from 'node:assert/strict';
import test from 'node:test';
import { currentPlansEqual, projectCurrentPlan } from './currentPlanProjection';

test('projects completed, executing, returned and pending tasks from the sole business plan', () => {
  const plan = projectCurrentPlan({ runSupervisorState: { goal: 'Inspect and verify.', plan: [
    { id: '1', capability: 'general', task: 'Understand', status: 'completed' },
    { id: '2', capability: 'explore', task: 'Inspect', status: 'executing' },
    { id: '3', capability: 'browser', task: 'Verify', status: 'pending' },
  ] } });
  assert.deepEqual(plan?.items.map((task) => [task.id, task.status]), [['1', 'completed'], ['2', 'active'], ['3', 'pending']]);
  assert.equal(projectCurrentPlan({ runSupervisorState: { plan: [
    { id: '1', capability: 'general', task: 'Review delivery', status: 'returned' },
  ] } })?.items[0].status, 'active');
});

test('completed A and pending B survive the gap and remain displayable from the saved snapshot', () => {
  const state = { runSupervisorState: { goal: 'Prepare and publish.', plan: [
    { id: '1', capability: 'general', task: 'Prepare', status: 'completed' },
    { id: '2', capability: 'general', task: 'Publish', status: 'pending' },
  ] } };
  assert.deepEqual(projectCurrentPlan(state)?.items.map((task) => task.status), ['completed', 'pending']);
  assert.deepEqual(projectCurrentPlan({ ...state, runId: 'next-run' }), projectCurrentPlan(state));
});

test('a pending plan renders without an active execution and empty states clear the panel', () => {
  assert.equal(projectCurrentPlan({ runSupervisorState: { plan: [
    { id: '1', capability: 'general', task: 'Draft', status: 'pending' },
  ] } })?.items.length, 1);
  for (const state of [{}, null, { runSupervisorState: { plan: [] } }]) assert.equal(projectCurrentPlan(state), null);
});

test('keeps identifiers exact and normalizes display text', () => {
  assert.deepEqual(projectCurrentPlan({ runSupervisorState: { plan: [
    { id: ' id ', capability: ' explore ', task: ' Inspect ', status: 'executing' },
  ] } })?.items, [{ id: ' id ', capability: 'explore', task: 'Inspect', status: 'active' }]);
});

test('excludes superseded and malformed tasks without interpreting message history', () => {
  const plan = projectCurrentPlan({ runSupervisorState: { plan: [
    { id: 'old', capability: 'general', task: 'Old task', status: 'superseded' },
    { id: 'new', capability: 'writer', task: 'New task', status: 'executing' },
    { id: 'invalid', task: 'Missing capability', status: 'pending' },
    { id: 'unknown', capability: 'general', task: 'Bad status', status: 'finished' },
  ] }, messages: [{ content: 'This is not a plan.' }] });
  assert.deepEqual(plan?.items, [{ id: 'new', capability: 'writer', task: 'New task', status: 'active' }]);
});

test('compares plans structurally to avoid duplicate transport events', () => {
  const plan = { items: [{ id: '1', capability: 'general', task: 'Plan', status: 'active' as const }] };
  assert.equal(currentPlansEqual(plan, { items: [{ ...plan.items[0] }] }), true);
  assert.equal(currentPlansEqual(plan, null), false);
});
