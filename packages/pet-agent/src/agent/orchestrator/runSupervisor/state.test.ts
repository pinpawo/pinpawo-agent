import assert from 'node:assert/strict';
import test from 'node:test';
import { currentSupervisorTask, runSupervisorStateSchema, updateSupervisorTask } from './state';

test('current work is derived from plan progress without a second active task record', () => {
  const state = runSupervisorStateSchema.parse({ goal: 'Deliver', plan: [
    { id: 'a', capability: 'general', task: 'First', status: 'completed' },
    { id: 'b', capability: 'general', task: 'Second', status: 'pending' },
  ] });
  assert.equal(currentSupervisorTask(state)?.id, 'b');
  const completed = updateSupervisorTask(state, 'b', 'completed');
  assert.equal(currentSupervisorTask(completed), null);
  assert.equal(state.plan[1].status, 'pending');
  assert.throws(() => updateSupervisorTask(state, 'missing', 'completed'));
});

test('business state rejects duplicated calls, messages and run metadata', () => {
  for (const key of ['proposal', 'pendingCall', 'messages', 'nextAttempt', 'run']) {
    assert.equal(runSupervisorStateSchema.safeParse({ goal: null, plan: [], [key]: null }).success, false);
  }
  for (const status of ['executing', 'returned']) {
    assert.equal(runSupervisorStateSchema.safeParse({ goal: 'Work', plan: [
      { id: 'task', capability: 'general', task: 'Work', status },
    ] }).success, false, 'execution progress belongs to messages, not the business plan');
  }
});
