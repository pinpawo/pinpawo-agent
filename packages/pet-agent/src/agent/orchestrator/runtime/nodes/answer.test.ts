import assert from 'node:assert/strict';
import test from 'node:test';
import { AIMessage } from '@langchain/core/messages';
import { getAgentMessageMetadata, setAgentMessageMetadata } from '../../../messages';
import { buildRunStateReset, type OrchestratorStateType } from '../../state';
import { createAnswerNode } from './answer';
import { ORCHESTRATOR_MAX_ITERATIONS } from '../constants';

function state(patch: Partial<OrchestratorStateType> = {}, reply?: string): OrchestratorStateType {
  const result = { ...buildRunStateReset(), messages: [], sessionCapabilityArtifacts: [], runSupervisorState: { goal: null, plan: [] }, sessionToolAuthorizations: { generation: '', records: [] }, ...patch };
  if (reply !== undefined) result.messages = [setAgentMessageMetadata(new AIMessage(reply), {
    lane: 'supervisor', runId: result.runId, traceId: result.traceId,
  })];
  return result;
}

test('terminal delivers supplied text intact, once, and clears invocation state without a model', async () => {
  const reply = '  检查已完成。\n\n请选择下一项。  ';
  const result = await createAnswerNode()(state({}, reply));
  assert.equal(result.messages.length, 1);
  assert.equal(result.messages[0].text, reply);
  assert.equal('runSupervisorReply' in result, false);
  assert.equal('runSupervisorState' in result, false);
  assert.equal('taskRunContinuation' in result, false);
});

test('terminal preserves a remaining plan after accepting the active task', async () => {
  const plan = [{ capability: 'general', task: 'Publish after the user chooses a target.' }];
  const result = await createAnswerNode()(state({
    runUserRequest: 'Prepare and publish.', traceId: 'task-1',
    runSupervisorState: { goal: 'Prepare and publish.', plan: plan.map((task) => ({ ...task, id: 'future', status: 'pending' })) },
  }, 'Choose a target.'));
  assert.equal('runSupervisorState' in result, false, 'answer must not overwrite saved progress');
});

test('terminal does not fabricate a reply for a missing proposal and empty text', async () => {
  await assert.rejects(createAnswerNode()(state()), /requires a supplied reply/);
});

test('root iteration stop is rendered deterministically', async () => {
  const result = await createAnswerNode()(state({ runIterationCount: ORCHESTRATOR_MAX_ITERATIONS }));
  assert.equal(result.messages.length, 1);
  assert.equal('runIterationCount' in result, false, 'budget is reset only at fresh run entry');
});

test('terminal never republishes another run reply and stamps both identities on the main reply', async () => {
  const previous = state({}, 'Old reply');
  await assert.rejects(createAnswerNode()({ ...previous, ...buildRunStateReset() }), /requires a supplied reply/);
  const result = await createAnswerNode()(previous);
  assert.deepEqual(getAgentMessageMetadata(result.messages[0]), {
    createdAt: getAgentMessageMetadata(result.messages[0]).createdAt,
    runId: previous.runId, traceId: previous.traceId,
  });
});
