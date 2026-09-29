import assert from 'node:assert/strict';
import test from 'node:test';
import { AIMessage, HumanMessage, RemoveMessage } from '@langchain/core/messages';
import { getAgentMessageMetadata, setAgentMessageMetadata } from '../../../messages';
import { buildOrchestratorRunInput, type OrchestratorStateType } from '../../state';
import { createPrepareNode } from './prepare';

function state(): OrchestratorStateType {
  return { ...buildOrchestratorRunInput([new HumanMessage({ id: 'human', content: 'Inspect.' })]),
    runSupervisorState: { runId: null, goal: null, plan: [] }, sessionCapabilityArtifacts: [],
    sessionToolAuthorizations: { generation: '', records: [] } };
}

test('prepare preserves initialized run identity and binds its current human trace', async () => {
  const input = state();
  const command = await createPrepareNode()(input);
  const update = command.update as Partial<OrchestratorStateType>;
  assert.equal(update.runId, undefined);
  assert.equal(update.taskId, undefined);
  assert.equal(update.messages?.[0].id, 'human');
  assert.deepEqual(getAgentMessageMetadata(update.messages![0]), { runId: input.runId, taskId: input.taskId });
});

test('prepare rejects uninitialized runs and unbound historical input instead of manufacturing a run', async () => {
  const input = state();
  for (const patch of [{ runId: '' }, { taskId: '' }, { messages: [new HumanMessage('Old unbound message')] }]) {
    await assert.rejects(createPrepareNode()({ ...input, ...patch }), /initialized|bound to its runId/);
  }
});

test('prepare drops earlier runs\' Supervisor work and keeps main history and the current run', async () => {
  const input = state();
  const work = (id: string, runId: string) => setAgentMessageMetadata(new AIMessage({ id, content: 'Private work.' }), { lane: 'supervisor', runId });
  const mainReply = setAgentMessageMetadata(new AIMessage({ id: 'reply', content: 'Done.' }), { runId: 'old-run' });
  const command = await createPrepareNode()({ ...input,
    messages: [work('old-work', 'old-run'), mainReply, work('current-work', input.runId), ...input.messages] });
  const update = command.update as Partial<OrchestratorStateType>;
  const removed = update.messages!.filter((message) => RemoveMessage.isInstance(message)).map(({ id }) => id);
  assert.deepEqual(removed, ['old-work']);
  assert.equal(update.messages!.at(-1)!.id, 'human');
});
