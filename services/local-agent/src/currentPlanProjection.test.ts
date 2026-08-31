import assert from 'node:assert/strict';
import test from 'node:test';
import { currentPlansEqual, projectCurrentPlan } from './currentPlanProjection';

test('projects the active delegation, its history, and the remaining plan', () => {
  const plan = projectCurrentPlan({
    taskActiveDelegation: {
      id: 'delegation-2',
      lane: 'capability:explore',
      task: 'Inspect the repository',
    },
    runDelegationSummaries: [
      {
        id: 'delegation-1',
        lane: 'capability:general',
        task: 'Understand the request',
        status: 'completed',
      },
      {
        id: 'delegation-2',
        lane: 'capability:explore',
        task: 'Inspect the repository',
        status: 'progress',
      },
    ],
    runSupervisorSession: { plan: [
      { capability: 'browser', task: 'Verify the result' },
    ] },
  });

  assert.deepEqual(plan, {
    items: [
      {
        id: 'delegation-1',
        capability: 'general',
        task: 'Understand the request',
        status: 'completed',
      },
      {
        id: 'delegation-2',
        capability: 'explore',
        task: 'Inspect the repository',
        status: 'active',
      },
      {
        id: 'pending:browser:0',
        capability: 'browser',
        task: 'Verify the result',
        status: 'pending',
      },
    ],
  });
  assert.equal(projectCurrentPlan({ runSupervisorSession: { plan: [] } }), null);
});

test('a plan survives the gap between delegations', () => {
  // No delegation is running, but completed work and remaining steps stay
  // meaningful — clearing here is what made the panel look frozen.
  const plan = projectCurrentPlan({
    runDelegationSummaries: [
      {
        id: 'delegation-1',
        lane: 'capability:general',
        task: 'Understand the request',
        status: 'completed',
      },
    ],
    runSupervisorSession: { plan: [{ capability: 'explore', task: 'Inspect the repository' }] },
  });

  assert.deepEqual(plan?.items.map((item) => [item.capability, item.status]), [
    ['general', 'completed'],
    ['explore', 'pending'],
  ]);
});

test('a remaining capability plan alone still renders', () => {
  const plan = projectCurrentPlan({
    runSupervisorSession: { plan: [{ capability: 'general', task: 'Draft the reply' }] },
  });
  assert.equal(plan?.items.length, 1);
  assert.equal(plan?.items[0]?.status, 'pending');
});

test('a resumable task projects its continuation tail after the run session is discarded', () => {
  const plan = projectCurrentPlan({
    taskRunContinuation: {
      remainingPlan: [{ capability: 'general', task: 'Resume the remaining work' }],
    },
  });
  assert.equal(plan?.items[0]?.task, 'Resume the remaining work');
  assert.equal(plan?.items[0]?.status, 'pending');
});

test('an empty orchestration state clears the plan', () => {
  assert.equal(projectCurrentPlan({}), null);
  assert.equal(projectCurrentPlan(null), null);
  assert.equal(
    projectCurrentPlan({ runDelegationSummaries: [], runSupervisorSession: { plan: [] } }),
    null,
  );
});

test('compares plans structurally to avoid duplicate transport events', () => {
  const plan = { items: [{
    id: '1',
    capability: 'general',
    task: 'Plan',
    status: 'active' as const,
  }] };
  assert.equal(currentPlansEqual(plan, { items: [{ ...plan.items[0] }] }), true);
  assert.equal(currentPlansEqual(plan, null), false);
});

test('keeps delegation identifiers exact while normalizing display text', () => {
  const plan = projectCurrentPlan({
    taskActiveDelegation: {
      id: ' delegation-1 ',
      lane: 'capability:explore',
      task: ' Inspect the repository ',
    },
    runDelegationSummaries: [{
      id: ' delegation-1 ',
      lane: 'capability:explore',
      task: ' Inspect the repository ',
      status: 'progress',
    }],
    runSupervisorSession: { plan: [] },
  });

  assert.deepEqual(plan, {
    items: [{
      id: ' delegation-1 ',
      capability: 'explore',
      task: 'Inspect the repository',
      status: 'active',
    }],
  });
});
