import assert from 'node:assert/strict';
import test from 'node:test';
import { parseSupervisorCommand } from './protocol';
const context = { mode: 'boundary' as const, activeDelegation: {
  delegationId: 'd1', runId: 'r1', capability: 'general', task: 'Verify the change.',
}, allowedCapabilityNames: ['general'] };
const tasks = [{ capability: 'general', task: 'Publish the change.' }];

test('entry cannot accept or continue an absent delegation', () => {
  const entry = { ...context, mode: 'entry' as const, activeDelegation: null };
  for (const command of [
    { action: 'accept_result', remainingPlan: tasks, },
    { action: 'continue_current' },
    { action: 'accept_result', reply: 'Done.', remainingPlan: [] },
  ]) assert.throws(() => parseSupervisorCommand(command, entry));
  assert.equal(parseSupervisorCommand({ action: 'execute_plan', tasks, }, entry).action, 'execute_plan');
});

test('Boundary accepts or continues but cannot submit a replacement plan', () => {
  assert.throws(() => parseSupervisorCommand({ action: 'execute_plan', tasks }, context));
  for (const action of ['accept_result', 'continue_current']) {
    assert.deepEqual(parseSupervisorCommand({ action, remainingPlan: tasks }, context), { action, remainingPlan: tasks });
  }
});

test('invalid combinations cannot dispatch, change continuation tasks, or reference unavailable capabilities', () => {
  for (const command of [
    { action: 'accept_result', remainingPlan: [] },
    { action: 'execute_plan', tasks: [{ capability: 'missing', task: 'Work' }], },
    { action: 'continue_current', tasks },
    { action: 'accept_result', reply: ' ', remainingPlan: [] },
    { action: 'accept_result', reply: 'Done', remainingPlan: [], tasks },
    { action: 'goal_done', tasks: [] },
  ]) assert.throws(() => parseSupervisorCommand(command, context));
});

test('acceptance with a reply preserves the exact supplied reply and revalidated remaining plan', () => {
  const command = { action: 'accept_result', reply: '  Done.\nChoose a target.  ', remainingPlan: tasks };
  assert.deepEqual(parseSupervisorCommand(command, context), command);
});
