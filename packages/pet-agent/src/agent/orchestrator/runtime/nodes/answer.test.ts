import assert from 'node:assert/strict';
import test from 'node:test';
import { AIMessage, ToolMessage } from '@langchain/core/messages';
import { END, MemorySaver, START, StateGraph } from '@langchain/langgraph';
import { getAgentMessageMetadata, setAgentMessageMetadata } from '../../../messages';
import { buildRunStateReset, OrchestratorState, type OrchestratorStateType } from '../../state';
import { createOrchestratorGraph } from '../graph';
import type { AgentModels } from '../../../../types/agent';
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

function legacyReplyState() {
  const saved = state({ runSupervisorState: { goal: 'Inspect.', plan: [
    { id: 'task', capability: 'general', task: 'Inspect.', status: 'completed' },
  ] } });
  saved.messages = [
    new AIMessage({ content: '', tool_calls: [{ id: 'review', name: 'review_current', args: {
      completed: true, reason: 'Inspection verified.', reply: 'Inspection complete.',
    } }] }),
    new ToolMessage({ name: 'review_current', tool_call_id: 'review', content: 'Control decision submitted.' }),
  ].map((message) => setAgentMessageMetadata(message, { lane: 'supervisor', runId: saved.runId, traceId: saved.traceId }));
  return saved;
}

test('a pre-upgrade checkpoint waiting at answer resumes without rerunning the model or Capability', async () => {
  const checkpointer = new MemorySaver();
  const saved = legacyReplyState();
  // Reproduce the previous runtime's committed control pair and pending answer node.
  const previousGraph = new StateGraph(OrchestratorState)
    .addNode('runSupervisor', () => saved)
    .addNode('answer', () => { throw new Error('Pause before publishing.'); })
    .addEdge(START, 'runSupervisor').addEdge('runSupervisor', 'answer').addEdge('answer', END)
    .compile({ checkpointer });
  const options = { configurable: { thread_id: 'legacy-answer-restart' } };
  await previousGraph.invoke({}, { ...options, interruptBefore: ['answer'] });
  assert.deepEqual((await previousGraph.getState(options)).next, ['answer']);
  const models = { act: { bindTools() { return this; }, invoke: () => { throw new Error('Must not rerun models'); } } } as unknown as AgentModels;
  const graph = createOrchestratorGraph({ models, checkpoint: checkpointer });
  const output = await graph.invoke(null, options);
  assert.equal(output.messages.at(-1)?.text, 'Inspection complete.');
  assert.deepEqual(output.runSupervisorState, saved.runSupervisorState);
  const resumedAgain = await graph.invoke(null, options);
  assert.equal(resumedAgain.messages.filter((message) => !getAgentMessageMetadata(message).lane
    && message.text === 'Inspection complete.').length, 1);
});

test('legacy replies require a successful matching control pair from the current run', async () => {
  for (const mutation of [
    (saved: OrchestratorStateType) => { saved.runId = 'another-run'; },
    (saved: OrchestratorStateType) => { saved.traceId = 'another-trace'; },
    (saved: OrchestratorStateType) => { (saved.messages[1] as ToolMessage).status = 'error'; },
    (saved: OrchestratorStateType) => { (saved.messages[1] as ToolMessage).tool_call_id = 'another-call'; },
    (saved: OrchestratorStateType) => { saved.messages.pop(); },
  ]) {
    const saved = legacyReplyState();
    mutation(saved);
    await assert.rejects(createAnswerNode()(saved), /requires a supplied reply/);
  }
});
