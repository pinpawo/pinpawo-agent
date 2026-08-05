import assert from 'node:assert/strict';
import test from 'node:test';
import { currentPlansEqual, projectCurrentPlan } from './currentPlanProjection';

test('projects a current plan only while taskActiveDelegation exists', () => {
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
    runCapabilityPlan: [
      { capability: 'browser', task: 'Verify the result' },
    ],
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
  assert.equal(projectCurrentPlan({ runCapabilityPlan: [] }), null);
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
    runCapabilityPlan: [],
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
