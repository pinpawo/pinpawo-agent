import assert from 'node:assert/strict';
import test from 'node:test';
import { parsePlannerCommit } from './protocol';

const boundaryContext = {
  mode: 'boundary' as const,
  activeDelegation: {
    delegationId: 'delegation-1',
    transcriptRunId: 'transcript-1',
    capability: 'general',
    task: 'Complete the current task.',
  },
  allowedCapabilityNames: ['general', 'explore'],
};

test('Planner commit exposes only action and plan tasks', () => {
  assert.deepEqual(parsePlannerCommit({
    action: 'execute_plan',
    tasks: [{ capability: 'explore', task: 'Inspect the repository.' }],
  }, {
    ...boundaryContext,
    mode: 'entry',
    activeDelegation: null,
  }), {
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
  }, boundaryContext), /forbids tasks/);
  assert.deepEqual(parsePlannerCommit({
    action: 'continue_current',
    tasks: [],
  }, boundaryContext), {
    action: 'continue_current',
    tasks: [],
  });
  assert.throws(() => parsePlannerCommit({
    action: 'continue_current',
    tasks: [],
    gapNote: 'The previous result omitted verification; run it and return the evidence.',
  }, boundaryContext));
  assert.throws(() => parsePlannerCommit({
    action: 'execute_plan',
    tasks: [{ capability: 'explore', task: 'Start a replacement plan.' }],
  }, boundaryContext), /invalid at a boundary/);
  assert.throws(() => parsePlannerCommit({
    action: 'advance_plan',
    tasks: [{ capability: 'explore', task: 'Continue with the next executor.' }],
  }, {
    ...boundaryContext,
    mode: 'entry',
    activeDelegation: null,
  }), /invalid at entry/);
  assert.deepEqual(parsePlannerCommit({
    action: 'advance_plan',
    tasks: [{ capability: 'explore', task: 'Continue with the next executor.' }],
  }, boundaryContext), {
    action: 'advance_plan',
    tasks: [{ capability: 'explore', task: 'Continue with the next executor.' }],
  });
  assert.throws(() => parsePlannerCommit({
    action: 'goal_done',
    tasks: [{ capability: 'general', task: 'Unexpected work.' }],
  }, boundaryContext), /forbids tasks/);
  assert.throws(() => parsePlannerCommit({
    action: 'goal_done',
    tasks: [],
    gapNote: 'Unexpected continuation guidance.',
  }, boundaryContext));
});
