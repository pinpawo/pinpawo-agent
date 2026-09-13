import assert from 'node:assert/strict';
import test from 'node:test';
import { capabilityHandoffSchema, controlSchema } from './protocol';

test('control schemas describe plan, review, adjustment and explicit execution without persisted dispatch state', () => {
  const tasks = [{ capability: 'general', task: 'Verify the change' }];
  for (const control of [
    { name: 'submit_plan', args: { tasks } },
    { name: 'execute_current', args: {} },
    { name: 'execute_current', args: { guidance: 'Check the missing evidence.' } },
    { name: 'review_current', args: { completed: false, reason: 'Missing verification' } },
    { name: 'review_current', args: { completed: true, reason: 'Verified' } },
    { name: 'adjust_plan', args: { goal: 'Updated goal', reason: 'New request', currentDelegation: 'replace', tasks } },
  ]) assert.deepEqual(controlSchema.parse(control), control);
});

test('control schemas reject unknown fields, empty tasks and invalid review values', () => {
  for (const control of [
    { name: 'submit_plan', args: { tasks: [] } },
    { name: 'review_current', args: { reason: ' ' } },
    { name: 'review_current', args: { reason: 'Review', completed: 'false' } },
    { name: 'review_current', args: { reason: 'Review', reply: ' ' } },
    { name: 'review_current', args: { reason: 'Review', pendingCall: {} } },
    { name: 'review_current', args: { completed: true, reason: 'Verified', reply: 'Done' } },
    { name: 'execute_current', args: { taskId: 'model-selected-task' } },
    { name: 'execute_current', args: { guidance: ' ' } },
    { name: 'delegate_capability', args: {} },
  ]) assert.equal(controlSchema.safeParse(control).success, false);
});

test('Capability handoff requires an explicit execution decision', () => {
  const execution = { taskId: 'task', delegationId: 'delegation', capability: 'general',
    task: 'Verify the change', mode: 'initial', guidance: null };
  assert.equal(capabilityHandoffSchema.safeParse({ control: { name: 'execute_current', args: {} }, execution }).success, true);
  for (const control of [
    { name: 'submit_plan', args: { tasks: [{ capability: 'general', task: execution.task }] } },
    { name: 'review_current', args: { completed: true, reason: 'Verified' } },
    { name: 'review_current', args: { reason: 'Verified', reply: 'Done' } },
    { name: 'adjust_plan', args: { goal: execution.task, reason: 'Revised', currentDelegation: 'replace',
      tasks: [{ capability: 'general', task: execution.task }] } },
  ]) assert.equal(capabilityHandoffSchema.safeParse({ control, execution }).success, false);
});
