import assert from 'node:assert/strict';
import test from 'node:test';
import { currentSupervisorTask, runSupervisorStateSchema, updateSupervisorTask } from './state';

test('current work is derived from plan progress without a second active task record', () => {
  const state = runSupervisorStateSchema.parse({ goal: 'Deliver', plan: [
    { id: 'a', capability: 'general', task: 'First', status: 'completed' },
    { id: 'b', capability: 'general', task: 'Second', status: 'pending' },
  ] });
  assert.equal(currentSupervisorTask(state)?.id, 'b');
  const returned = updateSupervisorTask(state, 'b', 'returned');
  assert.equal(currentSupervisorTask(returned)?.status, 'returned');
  assert.equal(state.plan[1].status, 'pending');
  assert.equal(currentSupervisorTask(updateSupervisorTask(returned, 'b', 'completed')), null);
  assert.throws(() => updateSupervisorTask(state, 'missing', 'executing'));
});

test('business state rejects duplicated calls, messages and run metadata', () => {
  for (const key of ['proposal', 'pendingCall', 'messages', 'nextAttempt', 'run']) {
    assert.equal(runSupervisorStateSchema.safeParse({ goal: null, plan: [], [key]: null }).success, false);
  }
});
