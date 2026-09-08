import assert from 'node:assert/strict';
import test from 'node:test';
import { parseSupervisorCommand } from './protocol';
const context = { mode: 'boundary' as const, activeDelegation: {
  delegationId: 'd1', runId: 'r1', capability: 'general', task: 'Verify the change.',
}, allowedCapabilityNames: ['general'] };
const tasks = [{ capability: 'general', task: 'Publish the change.' }];
const review = { action: 'review_current', completed: true, reason: 'Verification passed.' };

test('Entry only submits a plan and Boundary only reviews an active delegation', () => {
  const entry = { ...context, mode: 'entry' as const, activeDelegation: null };
  for (const completed of [true, false]) {
    const command = { ...review, completed };
    assert.throws(() => parseSupervisorCommand(command, entry));
    assert.throws(() => parseSupervisorCommand(command, { ...context, activeDelegation: null }));
    assert.deepEqual(parseSupervisorCommand(command, context), command);
  }
  assert.equal(parseSupervisorCommand({ action: 'execute_plan', tasks }, entry).action, 'execute_plan');
  assert.throws(() => parseSupervisorCommand({ action: 'execute_plan', tasks }, context));
});

test('review requires an explicit boolean and concrete reason and rejects invalid combinations', () => {
  for (const command of [
    { ...review, completed: undefined }, { ...review, completed: 'false' },
    { ...review, reason: undefined }, { ...review, reason: ' ' },
    { ...review, remainingPlan: [] },
    { ...review, completed: false, reply: 'Need input.' },
    { ...review, remainingPlan: [{ capability: 'missing', task: 'Work' }] },
    { ...review, tasks }, { ...review, reply: ' ' },
    { ...review, action: 'accept_result' }, { ...review, action: 'continue_current' },
  ]) assert.throws(() => parseSupervisorCommand(command, context));
});

test('reviews preserve replies and cannot carry plan mutations', () => {
  const command = { ...review, reply: '  Done.\nChoose a target.  ' };
  assert.deepEqual(parseSupervisorCommand(command, context), command);
  const incomplete = { ...review, completed: false, remainingPlan: [] };
  assert.throws(() => parseSupervisorCommand(incomplete, context));
});
