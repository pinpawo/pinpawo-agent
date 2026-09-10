import assert from 'node:assert/strict';
import test from 'node:test';
import type { AgentModels } from '../../../../types/agent';
import { buildRunStateReset, type OrchestratorStateType } from '../../state';
import { createAnswerNode } from './answer';
import { ORCHESTRATOR_MAX_ITERATIONS } from '../constants';

const models = { act: { invoke: () => { throw new Error('Terminal must not invoke a model'); } } } as unknown as AgentModels;
function state(patch: Partial<OrchestratorStateType> = {}): OrchestratorStateType {
  return { ...buildRunStateReset(), messages: [], sessionCapabilityArtifacts: [], runSupervisorState: { goal: null, plan: [] }, sessionToolAuthorizations: { generation: '', records: [] }, ...patch };
}

test('terminal delivers supplied text intact, once, and clears invocation state without a model', async () => {
  const reply = '  检查已完成。\n\n请选择下一项。  ';
  const result = await createAnswerNode({ models })(state({ runSupervisorReply: reply }));
  assert.equal(result.messages.length, 1);
  assert.equal(result.messages[0].text, reply);
  assert.equal(result.runSupervisorReply, null);
  assert.equal('runSupervisorState' in result, false);
  assert.equal('taskRunContinuation' in result, false);
});

test('terminal preserves a remaining plan after accepting the active task', async () => {
  const plan = [{ capability: 'general', task: 'Publish after the user chooses a target.' }];
  const result = await createAnswerNode({ models })(state({
    runUserRequest: 'Prepare and publish.', traceId: 'task-1', runSupervisorReply: 'Choose a target.',
    runSupervisorState: { goal: 'Prepare and publish.', plan: plan.map((task) => ({ ...task, id: 'future', status: 'pending' })) },
  }));
  assert.equal('runSupervisorState' in result, false, 'answer must not overwrite saved progress');
});

test('terminal does not fabricate a reply for a missing proposal and empty text', async () => {
  await assert.rejects(createAnswerNode({ models })(state()), /requires a supplied reply/);
});

test('root iteration stop is rendered deterministically', async () => {
  const result = await createAnswerNode({ models })(state({ runIterationCount: ORCHESTRATOR_MAX_ITERATIONS }));
  assert.equal(result.messages.length, 1);
  assert.equal('runIterationCount' in result, false, 'budget is reset only at fresh run entry');
});
