import assert from 'node:assert/strict';
import test from 'node:test';
import { capabilityExecutionSnapshotSchema, controlSchema } from './protocol';

test('control schemas describe plan, review, adjustment and explicit execution without persisted dispatch state', () => {
  const tasks = [{ capability: 'general', task: 'Verify the change' }];
  for (const control of [
    { name: 'submit_plan', args: { tasks } },
    { name: 'delegate_capability', args: { briefing: 'Check the missing evidence.' } },
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
    { name: 'delegate_capability', args: {} },
    { name: 'delegate_capability', args: { briefing: null } },
    { name: 'delegate_capability', args: { briefing: 'Execute', guidance: 'Old field' } },
    { name: 'delegate_capability', args: { taskId: 'model-selected-task' } },
    { name: 'delegate_capability', args: { briefing: ' ' } },
    { name: 'execute_current', args: {} },
    { name: 'delegate_capability', args: { control: {}, execution: {} } },
  ]) assert.equal(controlSchema.safeParse(control).success, false);
});

test('execution snapshot is internal and does not duplicate model arguments', () => {
  const snapshot = { taskId: 'task', delegationId: 'delegation', capability: 'general',
    task: 'Verify the change', mode: 'initial' };
  assert.deepEqual(capabilityExecutionSnapshotSchema.parse(snapshot), snapshot);
  assert.equal(capabilityExecutionSnapshotSchema.safeParse({ ...snapshot, briefing: 'Duplicate' }).success, false);
});

test('briefing accepts a complete formatted handoff beyond the former guidance limit without rewriting it', () => {
  const briefing = '  # Execution context\n\n' + 'Evidence and reference details.\n'.repeat(150) + '\nReturn a verified result.  ';
  assert.ok(briefing.length > 2_000);
  const parsed = controlSchema.parse({ name: 'delegate_capability', args: { briefing } });
  assert.equal(parsed.name, 'delegate_capability');
  if (parsed.name === 'delegate_capability') assert.equal(parsed.args.briefing, briefing);
});
