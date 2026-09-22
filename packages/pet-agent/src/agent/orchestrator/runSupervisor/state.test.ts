import assert from 'node:assert/strict';
import test from 'node:test';
import { AIMessage } from '@langchain/core/messages';
import { currentSupervisorTask, runSupervisorStateSchema, supervisorPlanSnapshot, updateSupervisorTask } from './state';

test('current work is derived from plan progress without a second active task record', () => {
  const state = runSupervisorStateSchema.parse({ goal: 'Deliver', plan: [
    { id: 'a', capability: 'general', objective: 'First', status: 'completed' },
    { id: 'b', capability: 'general', objective: 'Second', status: 'pending' },
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
      { id: 'task', capability: 'general', objective: 'Work', status },
    ] }).success, false, 'execution progress belongs to messages, not the business plan');
  }
});


test('model plan excludes task transcripts while status updates retain them', () => {
  const state = runSupervisorStateSchema.parse({ goal: 'Deliver', plan: [{
    id: 'a', capability: 'general', objective: 'First', status: 'pending',
    delegation: { id: 'd', runId: 'r', taskId: 't', messages: [new AIMessage('Private evidence')] },
  }] });
  const snapshot = supervisorPlanSnapshot(state);
  assert.equal('delegation' in snapshot.plan[0], false);
  assert.ok(AIMessage.isInstance(state.plan[0].delegation?.messages[0]));
  assert.equal(updateSupervisorTask(state, 'a', 'completed').plan[0].delegation, state.plan[0].delegation);
});
