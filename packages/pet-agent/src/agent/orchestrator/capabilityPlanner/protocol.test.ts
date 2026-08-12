import assert from 'node:assert/strict';
import test from 'node:test';
import { parsePlannerCommit } from './protocol';

const boundaryContext = {
  mode: 'boundary' as const,
  activeDelegation: {
    delegationId: 'delegation-1',
    capability: 'general',
    task: 'Complete the current task.',
  },
  allowedCapabilityNames: ['general', 'explore'],
};

test('Planner commit exposes only action and plan tasks', () => {
  assert.deepEqual(parsePlannerCommit({
    action: 'execute_plan',
    tasks: [{ capability: 'explore', task: 'Inspect the repository.' }],
  }, boundaryContext), {
    action: 'execute_plan',
    tasks: [{ capability: 'explore', task: 'Inspect the repository.' }],
  });
  assert.throws(() => parsePlannerCommit({
    action: 'unavailable',
    tasks: [],
    reason: 'private reasoning must not cross the seam',
  }, boundaryContext));
  assert.throws(() => parsePlannerCommit({
    action: 'user_input_required',
    tasks: [],
    question: 'private question must not cross the seam',
  }, boundaryContext));
});

test('Planner commit enforces entry and continuation invariants', () => {
  assert.throws(() => parsePlannerCommit({
    action: 'goal_done',
    tasks: [],
  }, {
    ...boundaryContext,
    mode: 'entry',
    activeDelegation: null,
  }), /invalid at entry/);
  assert.throws(() => parsePlannerCommit({
    action: 'continue_current',
    tasks: [{ capability: 'explore', task: 'Switch executor.' }],
  }, boundaryContext), /must keep the active delegation capability/);
  assert.throws(() => parsePlannerCommit({
    action: 'goal_done',
    tasks: [{ capability: 'general', task: 'Unexpected work.' }],
  }, boundaryContext), /forbids tasks/);
});
