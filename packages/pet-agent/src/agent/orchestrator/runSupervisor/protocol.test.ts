import assert from 'node:assert/strict';
import test from 'node:test';
import { controlSchema } from './protocol';

test('control schemas describe plan, review and adjustment without persisted dispatch state', () => {
  const tasks = [{ capability: 'general', task: 'Verify the change' }];
  for (const control of [
    { name: 'submit_plan', args: { tasks } },
    { name: 'review_current', args: { reason: 'Start the pending task' } },
    { name: 'review_current', args: { completed: true, reason: 'Verified', reply: 'Done' } },
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
    { name: 'delegate_capability', args: {} },
  ]) assert.equal(controlSchema.safeParse(control).success, false);
});
