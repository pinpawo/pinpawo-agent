import assert from 'node:assert/strict';
import test from 'node:test';
import { HumanMessage } from '@langchain/core/messages';
import { Command, END, MemorySaver, START, StateGraph } from '@langchain/langgraph';
import type { AgentModels } from '../../../../types/agent';
import { defineInstructionDocument } from '../../../../types/capability';
import { queryAgentMessages, setAgentMessageMetadata } from '../../../messages';
import { compileAgentRegistry } from '../../registry';
import { buildRunStateReset, OrchestratorState, type OrchestratorStateType } from '../../state';
import type { RunSupervisorInput } from '../../runSupervisor/runner';
import { withScriptedDelegation, type ScriptedSupervisorDecision } from '../../runSupervisor/testing';
import { createRunSupervisorNode } from './runSupervisor';
import { pauseGate, afterPauseGate } from './pauseGate';
import { createAnswerNode } from './answer';
import { readCapabilityCall, capabilityResultMessage } from '../delegationToolResult';

const models = { act: {} } as AgentModels;
const registry = compileAgentRegistry({ toolkits: [], capabilities: ['general', 'writer'].map((name) => ({
  name, description: name, uses: [], instructions: defineInstructionDocument({ content: name }),
})) });
function pausedState(): OrchestratorStateType {
  const initial: OrchestratorStateType = {
    ...buildRunStateReset(), runId: 'r1', traceId: 't1', runIterationCount: 7,
    runUserRequest: 'Inspect the old project and publish.', runSupervisorUserMessageId: 'human:original',
    runSupervisorState: { goal: 'Inspect the old project and publish.', plan: [
      { id: 'task1', capability: 'general', task: 'Inspect the old project.', status: 'pending' },
      { id: 'task2', capability: 'writer', task: 'Publish the old result.', status: 'pending' },
    ] },
    taskPauseInterrupt: { kind: 'pause_task' },
    messages: [setAgentMessageMetadata(new HumanMessage({ id: 'original', content: 'Inspect the old project and publish.' }), { traceId: 't1', runId: 'r1' })],
    sessionCapabilityArtifacts: [], sessionToolAuthorizations: { generation: '', records: [] },
  };
  return initial;
}
function pauseInterruptId(output: unknown): string {
  const id = (output as { __interrupt__?: Array<{ id?: string }> }).__interrupt__?.[0]?.id;
  assert.ok(id); return id;
}
function adjustment(strategy: 'continue' | 'replace'): ScriptedSupervisorDecision {
  return { name: 'adjust_plan', args: { goal: 'Inspect the correct project; prepare a private report.',
    reason: 'User corrected the project and cancelled publication.', currentDelegation: strategy,
    tasks: [{ capability: strategy === 'continue' ? 'general' : 'writer', task: 'Work on the corrected project.' },
      { capability: 'writer', task: 'Prepare the private report.' }] } };
}
function harness(decide: (input: RunSupervisorInput) => ScriptedSupervisorDecision, checkpointer = new MemorySaver(),
  execute: (state: OrchestratorStateType) => void = () => {}) {
  return new StateGraph(OrchestratorState)
    .addNode('pauseGate', pauseGate)
    .addNode('runSupervisor', createRunSupervisorNode({ models, runSupervisorRunner: withScriptedDelegation({ invoke: async (input) => decide(input) }) }),
      { ends: ['capability', 'answer'] })
    .addNode('capability', (state) => {
      execute(state);
      const call = readCapabilityCall(state);
      return { messages: [capabilityResultMessage(state, call, { status: 'paused', delivery: null })] };
    })
    .addNode('answer', createAnswerNode({ models }))
    .addEdge(START, 'pauseGate')
    .addConditionalEdges('pauseGate', afterPauseGate, { runSupervisor: 'runSupervisor' })
    .addEdge('capability', END).addEdge('answer', END).compile({ checkpointer });
}

for (const strategy of ['continue', 'replace'] as const) {
  test(`native pause guidance lets Supervisor ${strategy} before execution without changing run identity or budget`, async () => {
    const initial = pausedState(); const events: string[] = [];
    const graph = harness((input) => {
      events.push('supervisor');
      assert.equal(input.mode, 'boundary'); assert.ok(input.inputId.startsWith('human:'));
      assert.equal(input.state.plan[1].task, 'Publish the old result.');
      assert.equal(input.messages.at(-1)?.text, 'Use the correct project and do not publish.');
      return adjustment(strategy);
    }, new MemorySaver(), () => { events.push('execute'); });
    const config = { configurable: { thread_id: strategy, registry } };
    const suspended = await graph.invoke(initial, config);
    assert.deepEqual(events, []);
    const result = await graph.invoke(new Command({ resume: { [pauseInterruptId(suspended)]: {
      action: 'continue', guidance: 'Use the correct project and do not publish.',
    } } }), config);
    assert.deepEqual(events, ['supervisor', 'execute']);
    assert.equal(result.runId, initial.runId); assert.equal(result.traceId, initial.traceId);
    assert.equal(result.runIterationCount, 7);
    assert.equal(result.runSupervisorState.goal, 'Inspect the correct project; prepare a private report.');
    assert.deepEqual(result.runSupervisorState.plan.map((task) => task.task), ['Work on the corrected project.', 'Prepare the private report.']);
    assert.equal(result.runSupervisorState.plan[0].id === 'task1', strategy === 'continue');
    assert.equal(queryAgentMessages(result.messages).supervisor(result.runId).select().messages.length, 2);
  });
}

test('empty native continue still lets Supervisor determine the next call from the saved plan', async () => {
  let decisions = 0;
  const graph = harness((input) => {
    decisions++;
    assert.ok(!input.inputId.startsWith('human:'));
    return { name: 'review_current', args: { reason: 'Proceed with the pending task.' } };
  });
  const config = { configurable: { thread_id: 'empty', registry } };
  const paused = await graph.invoke(pausedState(), config);
  const result = await graph.invoke(new Command({ resume: { [pauseInterruptId(paused)]: { action: 'continue' } } }), config);
  assert.equal(decisions, 1);
  assert.equal(result.runSupervisorState.plan[0].status, 'executing');
});

test('clarification preserves pending work; each native guidance message has an independent consumption identity', async () => {
  const ids: string[] = [];
  const graph = harness((input) => { ids.push(input.inputId); return { reply: 'Which project?' }; });
  const config = { configurable: { thread_id: 'repeat', registry } };
  let current = pausedState();
  for (let i = 0; i < 2; i++) {
    const paused = await graph.invoke(current, config);
    const result = await graph.invoke(new Command({ resume: { [pauseInterruptId(paused)]: { action: 'continue', guidance: 'Change project.' } } }), config);
    assert.deepEqual(result.runSupervisorState, current.runSupervisorState);
    current = { ...result, taskPauseInterrupt: { kind: 'pause_task' } };
  }
  assert.equal(new Set(ids).size, 2);
});

test('checkpointed adjustment resumes execution without repeating the Supervisor decision', async () => {
  const saver = new MemorySaver(); let decisions = 0; let executions = 0;
  const build = () => harness(() => { decisions++; return adjustment('replace'); }, saver, () => { executions++; });
  const config = { configurable: { thread_id: 'checkpoint', registry } };
  const paused = await build().invoke(pausedState(), config);
  await build().invoke(new Command({ resume: { [pauseInterruptId(paused)]: { action: 'continue', guidance: 'Start in the right project.' } } }),
    { ...config, interruptBefore: ['capability'] });
  assert.equal(decisions, 1); assert.equal(executions, 0);
  await build().invoke(null, config);
  assert.equal(decisions, 1); assert.equal(executions, 1);
});

test('execution alone cannot authorize plan adjustment; fresh guidance still cannot change a continued task capability', async () => {
  const state = pausedState();
  const node = (decision: ScriptedSupervisorDecision) => createRunSupervisorNode({ models,
    runSupervisorRunner: withScriptedDelegation({ invoke: async () => decision }) });
  const config = { configurable: { registry } };
  await assert.rejects(node(adjustment('replace'))(state, config), /fresh user input/);
  const fresh = { ...state, messages: [...state.messages, setAgentMessageMetadata(new HumanMessage({ id: 'new', content: 'Adjust.' }),
    { runId: state.runId, traceId: state.traceId })] };
  await assert.rejects(node({ name: 'adjust_plan', args: { goal: 'new', reason: 'new', currentDelegation: 'continue',
    tasks: [{ capability: 'writer', task: 'Write.' }] } })(fresh, config), /keep its capability/);
  await assert.rejects(node({ name: 'adjust_plan', args: { goal: 'new', reason: 'new', currentDelegation: 'replace',
    tasks: [{ capability: 'unknown', task: 'Write.' }] } })(fresh, config), /outside/);
});
