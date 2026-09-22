import assert from 'node:assert/strict';
import test from 'node:test';
import { capabilityExecutionSnapshotSchema } from './protocol';
import { submitPlanSchema } from './submitPlanTool';
import { adjustPlanSchema } from './adjustPlanTool';
import { reviewCurrentSchema } from './reviewCurrentTool';
import { delegateCapabilitySchema } from './delegateCapabilityTool';

test('control schemas describe plan, review, adjustment and explicit execution without persisted dispatch state', () => {
  const tasks = [{ capability: 'general', objective: 'Verify the change' }];
  for (const control of [
    { schema: submitPlanSchema, args: { tasks } },
    { schema: delegateCapabilitySchema, args: { briefing: 'Execute current objective.' } },
    { schema: reviewCurrentSchema, args: { completed: false, reason: 'Missing verification' } },
    { schema: reviewCurrentSchema, args: { completed: true, reason: 'Verified' } },
    { schema: adjustPlanSchema, args: { goal: 'Updated goal', reason: 'New request', currentTask: 'replace', tasks } },
  ]) assert.deepEqual(control.schema.parse(control.args), control.args);
});

test('control schemas reject unknown fields, empty tasks and invalid review values', () => {
  for (const control of [
    { schema: submitPlanSchema, args: { tasks: [] } },
    { schema: reviewCurrentSchema, args: { reason: ' ' } },
    { schema: reviewCurrentSchema, args: { reason: 'Review', completed: 'false' } },
    { schema: reviewCurrentSchema, args: { reason: 'Review', reply: ' ' } },
    { schema: reviewCurrentSchema, args: { reason: 'Review', pendingCall: {} } },
    { schema: reviewCurrentSchema, args: { completed: true, reason: 'Verified', reply: 'Done' } },
    { schema: delegateCapabilitySchema, args: { briefing: 'Task', priorDelegationIds: ['not-a-model-parameter'] } },
    { schema: delegateCapabilitySchema, args: { briefing: null } },
    { schema: delegateCapabilitySchema, args: { briefing: 'Execute', guidance: 'Old field' } },
    { schema: delegateCapabilitySchema, args: { planItemId: 'model-selected-task' } },
    { schema: delegateCapabilitySchema, args: { briefing: ' ' } },
    { schema: delegateCapabilitySchema, args: { control: {}, execution: {} } },
  ]) assert.equal(control.schema.safeParse(control.args).success, false);
});

test('execution snapshot is internal and does not duplicate model arguments', () => {
  const snapshot = { planItemId: 'task', delegationId: 'delegation', capability: 'general',
    task: 'Verify the change', briefing: 'Verify the change' };
  assert.deepEqual(capabilityExecutionSnapshotSchema.parse(snapshot), snapshot);
  assert.equal(capabilityExecutionSnapshotSchema.safeParse({ ...snapshot, briefing: undefined }).success, false);
});

test('plan objectives and delegation briefings have distinct schemas', () => {
  const tasks = [{ capability: 'general', objective: 'Verify the change' }];
  assert.deepEqual(submitPlanSchema.parse({ tasks }).tasks, tasks);
  assert.equal(submitPlanSchema.safeParse({ tasks: [{ ...tasks[0], briefing: 'Premature detail' }] }).success, false);
  const args = { briefing: '  # Current work\nUse prior evidence.  ' };
  assert.deepEqual(delegateCapabilitySchema.parse(args), args);
  assert.equal(delegateCapabilitySchema.safeParse({ ...args, capability: 'model-selected' }).success, false);
});
