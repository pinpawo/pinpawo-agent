import assert from 'node:assert/strict';
import test from 'node:test';
import { parseSupervisorCommand } from './protocol';

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

test('Supervisor command exposes only action, plan tasks, and a bounded user-input request', () => {
  assert.deepEqual(parseSupervisorCommand({
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
  assert.throws(() => parseSupervisorCommand({
    action: 'unavailable',
    tasks: [],
    reason: 'private reasoning must not cross the seam',
  }, boundaryContext));
  assert.throws(() => parseSupervisorCommand({
    action: 'user_input_required',
    tasks: [],
    userInputRequest: { question: 'Which target should I use?' },
    question: 'private question must not cross the seam',
  }, boundaryContext));
});

test('Supervisor command enforces entry and continuation invariants', () => {
  assert.throws(() => parseSupervisorCommand({
    action: 'goal_done',
    tasks: [],
  }, {
    ...boundaryContext,
    mode: 'entry',
    activeDelegation: null,
  }), /invalid at entry/);
  assert.deepEqual(parseSupervisorCommand({
    action: 'user_input_required',
    tasks: [],
    userInputRequest: { question: 'Which target should I use?' },
  }, {
    ...boundaryContext,
    mode: 'entry',
    activeDelegation: null,
  }), {
    action: 'user_input_required',
    tasks: [],
    userInputRequest: { question: 'Which target should I use?' },
  });
  assert.throws(() => parseSupervisorCommand({
    action: 'user_input_required',
    tasks: [],
  }, boundaryContext), /requires userInputRequest/);
  assert.throws(() => parseSupervisorCommand({
    action: 'unavailable',
    tasks: [],
    userInputRequest: { question: 'Unexpected question.' },
  }, boundaryContext), /forbids userInputRequest/);
  assert.throws(() => parseSupervisorCommand({
    action: 'continue_current',
    tasks: [{ capability: 'explore', task: 'Switch executor.' }],
  }, boundaryContext), /forbids tasks/);
  assert.deepEqual(parseSupervisorCommand({
    action: 'continue_current',
    tasks: [],
  }, boundaryContext), {
    action: 'continue_current',
    tasks: [],
  });
  assert.throws(() => parseSupervisorCommand({
    action: 'continue_current',
    tasks: [],
    gapNote: 'The previous result omitted verification; run it and return the evidence.',
  }, boundaryContext));
  assert.throws(() => parseSupervisorCommand({
    action: 'execute_plan',
    tasks: [{ capability: 'explore', task: 'Start a replacement plan.' }],
  }, boundaryContext), /invalid at a boundary/);
  assert.throws(() => parseSupervisorCommand({
    action: 'advance_plan',
    tasks: [{ capability: 'explore', task: 'Continue with the next executor.' }],
  }, {
    ...boundaryContext,
    mode: 'entry',
    activeDelegation: null,
  }), /invalid at entry/);
  assert.deepEqual(parseSupervisorCommand({
    action: 'advance_plan',
    tasks: [{ capability: 'explore', task: 'Continue with the next executor.' }],
  }, boundaryContext), {
    action: 'advance_plan',
    tasks: [{ capability: 'explore', task: 'Continue with the next executor.' }],
  });
  assert.throws(() => parseSupervisorCommand({
    action: 'goal_done',
    tasks: [{ capability: 'general', task: 'Unexpected work.' }],
  }, boundaryContext), /forbids tasks/);
  assert.throws(() => parseSupervisorCommand({
    action: 'goal_done',
    tasks: [],
    gapNote: 'Unexpected continuation guidance.',
  }, boundaryContext));
});
