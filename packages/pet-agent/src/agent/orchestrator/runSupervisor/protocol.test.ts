import assert from 'node:assert/strict';
import test from 'node:test';
import { capabilityExecutionSnapshotSchema } from './protocol';
import { submitPlanSchema } from './submitPlanTool';
import { adjustPlanSchema } from './adjustPlanTool';
import { reviewCurrentSchema } from './reviewCurrentTool';
import { delegateCapabilitySchema } from './delegateCapabilityTool';

test('control schemas describe plan, review, adjustment and explicit execution without persisted dispatch state', () => {
  const tasks = [{ capability: 'general', task: 'Verify the change' }];
  for (const control of [
    { schema: submitPlanSchema, args: { tasks } },
    { schema: delegateCapabilitySchema, args: {} },
    { schema: reviewCurrentSchema, args: { completed: false, reason: 'Missing verification' } },
    { schema: reviewCurrentSchema, args: { completed: true, reason: 'Verified' } },
    { schema: adjustPlanSchema, args: { goal: 'Updated goal', reason: 'New request', currentDelegation: 'replace', tasks } },
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
    { schema: delegateCapabilitySchema, args: { briefing: 'Do another task.' } },
    { schema: delegateCapabilitySchema, args: { briefing: null } },
    { schema: delegateCapabilitySchema, args: { briefing: 'Execute', guidance: 'Old field' } },
    { schema: delegateCapabilitySchema, args: { taskId: 'model-selected-task' } },
    { schema: delegateCapabilitySchema, args: { briefing: ' ' } },
    { schema: delegateCapabilitySchema, args: { control: {}, execution: {} } },
  ]) assert.equal(control.schema.safeParse(control.args).success, false);
});

test('execution snapshot is internal and does not duplicate model arguments', () => {
  const snapshot = { taskId: 'task', delegationId: 'delegation', capability: 'general',
    task: 'Verify the change', mode: 'initial', briefing: 'Verify the change' };
  assert.deepEqual(capabilityExecutionSnapshotSchema.parse(snapshot), snapshot);
  assert.equal(capabilityExecutionSnapshotSchema.safeParse({ ...snapshot, briefing: undefined }).success, false);
});

test('plan task accepts the complete formatted execution instructions without rewriting them', () => {
  const briefing = '  # Execution context\n\n' + 'Evidence and reference details.\n'.repeat(150) + '\nReturn a verified result.  ';
  assert.ok(briefing.length > 2_000);
  const parsed = submitPlanSchema.parse({ tasks: [{ capability: 'general', task: briefing }] });
  assert.equal(parsed.tasks[0].task, briefing);
});
