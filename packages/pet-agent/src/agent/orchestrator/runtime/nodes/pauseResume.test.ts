import assert from 'node:assert/strict';
import test from 'node:test';
import { AIMessage, HumanMessage } from '@langchain/core/messages';
import { Command, END, MemorySaver, START, StateGraph, messagesStateReducer } from '@langchain/langgraph';
import type { AgentModels } from '../../../../types/agent';
import { defineInstructionDocument } from '../../../../types/capability';
import { queryAgentMessages, setAgentMessageMetadata } from '../../../messages';
import { DelegationAnnounceMessage, getMessageHandoffSource } from '../../delegation';
import { compileAgentRegistry } from '../../registry';
import { buildRunStateReset, OrchestratorState, type OrchestratorStateType } from '../../state';
import type { RunSupervisorInput, RunSupervisorResult } from '../../runSupervisor/runner';
import { createRunSupervisorSession, snapshotRunTaskContinuation } from '../../runSupervisor/session';
import { buildRunSupervisorInput } from '../../runSupervisor/input';
import { applyActiveDelegationTransition } from '../activeDelegationTransition';
import { createRunSupervisorNode } from './runSupervisor';
import { pauseGate, afterPauseGate } from './pauseGate';
import { createAnswerNode } from './answer';

const models = { act: {} } as AgentModels;
const registry = compileAgentRegistry({ toolkits: [], capabilities: ['general', 'writer'].map((name) => ({
  name, description: name, uses: [], instructions: defineInstructionDocument({ content: name }),
})) });
const tail = [{ capability: 'writer', task: 'Publish the old result.' }];
function pausedState(): OrchestratorStateType {
  const active = { id: 'd1', lane: 'capability:general' as const, runId: 'r1', traceId: 't1',
    userRequest: 'Inspect the old project and publish.', task: 'Inspect the old project.',
    contextSummary: null, status: 'pending' as const, resultPreview: null };
  const session = createRunSupervisorSession({ runId: 'r1', plan: tail,
    capabilityDisclosure: { registryDigest: 'old', disclosedCapabilityNames: ['general'] } });
  return {
    ...buildRunStateReset(), runId: 'r1', traceId: 't1', runIterationCount: 7,
    runUserRequest: active.userRequest, runSupervisorSession: null,
    taskActiveDelegation: active, taskPauseInterrupt: { kind: 'pause_task' },
    taskRunContinuation: snapshotRunTaskContinuation({ activeDelegation: active,
      supervisorSession: session, traceId: 't1', userRequest: active.userRequest }),
    runDelegationSummaries: [{ id: 'd1', lane: active.lane, task: active.task, status: 'progress', resultPreview: 'Old work retained.' }],
    messages: [setAgentMessageMetadata(new HumanMessage({ id: 'original-user', content: active.userRequest }), { traceId: 't1', runId: 'r1' }),
      setAgentMessageMetadata(new AIMessage({ id: 'private-work', content: 'Previous private tool reasoning.' }),
        { traceId: 't1', runId: 'r1', lane: active.lane, delegationId: 'd1' })],
    sessionCapabilityArtifacts: [], sessionToolAuthorizations: { generation: '', records: [] },
  };
}
function pauseInterruptId(output: unknown): string {
  const id = (output as { __interrupt__?: Array<{ id?: string }> }).__interrupt__?.[0]?.id;
  assert.ok(id);
  return id;
}
function adjustment(currentDelegation: 'continue' | 'replace'): RunSupervisorResult {
  return { action: 'adjust_plan', goal: 'Inspect the correct project; prepare a private report.',
    reason: 'The user corrected the project and cancelled publication.', currentDelegation,
    tasks: [{ capability: currentDelegation === 'continue' ? 'general' : 'writer', task: 'Work on the corrected project.' },
      { capability: 'writer', task: 'Prepare the private report.' }] };
}
function harness(decide: (input: RunSupervisorInput) => RunSupervisorResult, checkpointer = new MemorySaver(),
  execute: (state: OrchestratorStateType) => void = () => {}) {
  return new StateGraph(OrchestratorState)
    .addNode('pauseGate', pauseGate)
    .addNode('runSupervisor', createRunSupervisorNode({ models, runSupervisorRunner: { invoke: async (input) => decide(input) } }), { ends: ['capability', 'answer'] })
    .addNode('capability', (state) => { execute(state); return {}; })
    .addNode('answer', createAnswerNode({ models }))
    .addEdge(START, 'pauseGate')
    .addConditionalEdges('pauseGate', afterPauseGate, { runSupervisor: 'runSupervisor', capability: 'capability', answer: 'answer' })
    .addEdge('capability', END).addEdge('answer', END).compile({ checkpointer });
}

for (const strategy of ['continue', 'replace'] as const) {
  test(`mid-run pause guidance lets Supervisor ${strategy} before execution without an Announce`, async () => {
    const initial = pausedState(); const events: string[] = [];
    const graph = harness((input) => {
      events.push('supervisor');
      assert.equal(input.mode, 'boundary'); assert.ok(input.inputId.startsWith('human:'));
      assert.deepEqual(input.remainingPlan, tail);
      assert.equal(input.messages.at(-1)?.text, 'Use the correct project and do not publish.');
      return adjustment(strategy);
    }, new MemorySaver(), () => { events.push('execute'); });
    const config = { configurable: { thread_id: strategy, registry } };
    const suspended = await graph.invoke(initial, config);
    assert.deepEqual(events, []);
    const id = pauseInterruptId(suspended);
    const result = await graph.invoke(new Command({ resume: { [id]: { action: 'continue', guidance: 'Use the correct project and do not publish.' } } }), config);
    assert.deepEqual(events, ['supervisor', 'execute']);
    assert.ok(result.runNextDelegation);
    assert.ok(result.taskActiveDelegation);
    assert.ok(result.runSupervisorSession);
    assert.equal(result.runId, initial.runId); assert.equal(result.traceId, initial.traceId);
    assert.equal(result.runSupervisorUserMessageId, null);
    assert.equal(result.runNextDelegation.task, 'Work on the corrected project.');
    assert.equal(result.taskActiveDelegation.userRequest, result.runUserRequest);
    assert.deepEqual(result.runSupervisorSession.plan, [{ capability: 'writer', task: 'Prepare the private report.' }]);
    assert.ok(result.messages.some((message) => message.id === 'private-work'));
    assert.equal(result.messages.some((message) => getMessageHandoffSource(message)?.taskAccepted), false);
    if (strategy === 'continue') {
      assert.equal(result.taskActiveDelegation?.id, 'd1');
      assert.equal(result.taskActiveDelegation.runId, initial.taskActiveDelegation!.runId);
      assert.equal(result.runNextDelegation.mode, 'continue');
      assert.equal(result.runDelegationSummaries[0].task, result.runNextDelegation.task);
    } else {
      assert.notEqual(result.taskActiveDelegation?.id, 'd1');
      assert.equal(result.runDelegationSummaries[0].status, 'superseded');
      assert.equal(result.runDelegationSummaries[0].resultPreview, 'Old work retained.');
      const selected = queryAgentMessages(result.messages).main().delegation({ lane: result.taskActiveDelegation.lane,
        runId: result.taskActiveDelegation.runId, delegationId: result.taskActiveDelegation?.id }).select();
      assert.equal(selected.messages.some((message) => message.id === 'private-work'), false);
    }
    const resumed = applyActiveDelegationTransition({ ...result, runActiveDelegationTransition: 'resume_active' });
    assert.equal(resumed.runUserRequest, result.runUserRequest);
  });
}

test('empty continue keeps the saved pending plan and bypasses Supervisor', async () => {
  const graph = harness(() => { throw new Error('No new input'); });
  const config = { configurable: { thread_id: 'empty', registry } };
  const paused = await graph.invoke(pausedState(), config);
  const result = await graph.invoke(new Command({ resume: { [pauseInterruptId(paused)]: { action: 'continue' } } }), config);
  assert.equal(result.taskActiveDelegation?.id, 'd1');
  assert.deepEqual(result.taskRunContinuation?.remainingPlan, tail);
});

test('a clarification preserves pending work and repeated pause inputs have independent identities', async () => {
  const ids: string[] = [];
  const graph = harness((input) => { ids.push(input.inputId); return { reply: 'Which project?' }; });
  const config = { configurable: { thread_id: 'repeat', registry } };
  let current = pausedState();
  for (let i = 0; i < 2; i++) {
    const paused = await graph.invoke(current, config);
    const result = await graph.invoke(new Command({ resume: { [pauseInterruptId(paused)]: { action: 'continue', guidance: 'Change project.' } } }), config);
    assert.equal(result.runNextDelegation, null);
    assert.equal(result.taskActiveDelegation?.id, 'd1');
    assert.deepEqual(result.taskRunContinuation?.remainingPlan, tail);
    assert.equal(result.runSupervisorUserMessageId, null);
    current = { ...result, taskPauseInterrupt: { kind: 'pause_task' } };
  }
  assert.equal(new Set(ids).size, 2);
});

test('a committed plan adjustment resumes execution without replaying the Supervisor decision', async () => {
  const saver = new MemorySaver(); let decisions = 0; let executions = 0;
  const build = () => harness(() => { decisions++; return adjustment('replace'); }, saver, () => { executions++; });
  const config = { configurable: { thread_id: 'checkpoint', registry } };
  const paused = await build().invoke(pausedState(), config);
  await build().invoke(new Command({ resume: { [pauseInterruptId(paused)]: { action: 'continue', guidance: 'Start fresh in the right project.' } } }), { ...config, interruptBefore: ['capability'] });
  assert.equal(decisions, 1); assert.equal(executions, 0);
  await build().invoke(null, config);
  assert.equal(decisions, 1); assert.equal(executions, 1);
});

test('root rejects execution-driven adjustments and unknown or changed continuation capabilities', async () => {
  const original = pausedState();
  const announce = setAgentMessageMetadata(new DelegationAnnounceMessage({ id: 'announce', sourceLane: 'capability:general',
    runId: 'r1', delegationId: 'd1', announceMessageId: 'delivery', task: original.taskActiveDelegation!.task,
    result: 'Progress.', createdAt: '2026-09-09T00:00:00Z' }), { traceId: 't1' });
  const ordinary = { ...original, runActiveDelegationTransition: 'resume_active' as const,
    messages: [...original.messages, announce] };
  const config = { configurable: { registry } };
  const node = (result: RunSupervisorResult) => createRunSupervisorNode({ models, runSupervisorRunner: { invoke: async () => result } });
  await assert.rejects(node(adjustment('replace'))(ordinary, config), /fresh user input/);
  const message = setAgentMessageMetadata(new HumanMessage({ id: 'new-user', content: 'Change direction.' }), { traceId: 't1', runId: 'r1' });
  const fresh = { ...ordinary, runSupervisorUserMessageId: message.id!, messages: [...ordinary.messages, message] };
  await assert.rejects(node({ ...adjustment('continue'), action: 'adjust_plan', goal: 'new', reason: 'new', currentDelegation: 'continue',
    tasks: [{ capability: 'writer', task: 'Write.' }] })(fresh, config), /keep its Capability/);
  await assert.rejects(node({ action: 'adjust_plan', goal: 'new', reason: 'new', currentDelegation: 'replace',
    tasks: [{ capability: 'unknown', task: 'Write.' }] })(fresh, config), /outside the immutable catalog/);
  const accepted = await node(adjustment('continue'))(fresh, config);
  const update = accepted.update as Partial<OrchestratorStateType>;
  const applied = { ...fresh, ...update, messages: messagesStateReducer(fresh.messages, update.messages ?? []) };
  const input = buildRunSupervisorInput({ nodeInput: applied, catalog: { registryDigest: 'c', capabilityNames: ['general'], entries: [] }, supervisorSession: applied.runSupervisorSession! }).input;
  assert.ok(input.inputId.startsWith('announce:'));
  await assert.rejects(node(adjustment('continue'))(applied, config), /fresh user input/);
});
