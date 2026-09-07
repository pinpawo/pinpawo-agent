import assert from 'node:assert/strict';
import test from 'node:test';
import { AIMessage, HumanMessage } from '@langchain/core/messages';
import { END, START, Command, MemorySaver, StateGraph, messagesStateReducer } from '@langchain/langgraph';
import type { AgentModels } from '../../../../types/agent';
import { defineInstructionDocument } from '../../../../types/capability';
import { setAgentMessageMetadata } from '../../../messages';
import { DelegationAnnounceMessage, getDelegationAnnounce, getMessageHandoffSource, projectDelegationAnnouncesForModel } from '../../delegation';
import { compileAgentRegistry } from '../../registry';
import { buildRunStateReset, OrchestratorState, type OrchestratorStateType } from '../../state';
import { createRunSupervisorSession } from '../../runSupervisor/session';
import { buildRunSupervisorInput } from '../../runSupervisor/input';
import type { RunSupervisorResult } from '../../runSupervisor/runner';
import { applyActiveDelegationTransition } from '../activeDelegationTransition';
import { afterContextPrep } from '../routes/afterContextPrep';
import { createAnswerNode } from './answer';
import { createRunSupervisorNode } from './runSupervisor';

const models = { act: { invoke: () => { throw new Error('Unexpected model call'); } } } as unknown as AgentModels;
const registry = compileAgentRegistry({ toolkits: [], capabilities: [{
  name: 'general', description: 'Execute work.', uses: [],
  instructions: defineInstructionDocument({ content: 'Execute the requested task.' }),
}] });
const options = { configurable: { registry } };
const tail = [{ capability: 'general', task: 'Publish after choosing a destination.' }];
function state(): OrchestratorStateType {
  const scope = { lane: 'capability:general' as const, runId: 'r1', delegationId: 'd1' };
  const announce = new DelegationAnnounceMessage({
    id: 'a1', sourceLane: scope.lane, runId: scope.runId, delegationId: scope.delegationId,
    announceMessageId: 'a1', task: 'Prepare the document.', result: 'Draft saved; publication has not run.',
    createdAt: '2026-09-05T00:00:00Z',
  });
  return {
    ...buildRunStateReset(), runId: 'r1', traceId: 't1', runUserRequest: 'Prepare and publish.',
    messages: [new HumanMessage('Prepare and publish.'), announce],
    taskActiveDelegation: { id: 'd1', lane: scope.lane, runId: 'r1', traceId: 't1', task: 'Prepare the document.',
      contextSummary: null, status: 'awaiting_decision', resultPreview: announce.text, userRequest: 'Prepare and publish.' },
    runDelegationSummaries: [{ id: 'd1', lane: scope.lane, task: 'Prepare the document.', status: 'progress', resultPreview: announce.text }],
    runSupervisorSession: createRunSupervisorSession({ runId: 'r1', plan: tail, capabilityDisclosure: {
      registryDigest: 'registry', disclosedCapabilityNames: ['general'], emptySearchRounds: 0, maxEmptySearchRounds: 2, status: 'open',
    } }),
    taskRunContinuation: null, sessionCapabilityArtifacts: [], sessionToolAuthorizations: { generation: '', records: [] },
  };
}
function node(result: RunSupervisorResult) {
  return createRunSupervisorNode({ models, runSupervisorRunner: { invoke: async () => result } });
}
function apply(input: OrchestratorStateType, command: Command): OrchestratorStateType {
  const update = command.update as Partial<OrchestratorStateType>;
  return { ...input, ...update, messages: messagesStateReducer(input.messages, update.messages ?? []) };
}

test('acceptance advances the stable plan and updates the original Announce in place', async () => {
  const input = state();
  const evidence = input.messages.at(-1)!;
  input.messages.push(new HumanMessage('A later message.'));
  const command = await node({ action: 'accept_result' })(input, options);
  const next = apply(input, command);
  assert.deepEqual(command.goto, ['capability']);
  assert.notEqual(next.taskActiveDelegation?.id, 'd1');
  assert.equal(next.runDelegationSummaries[0].status, 'completed');
  assert.equal(next.messages.length, input.messages.length);
  assert.equal(next.messages[1].id, evidence.id);
  assert.deepEqual(getDelegationAnnounce(next.messages[1]), getDelegationAnnounce(evidence));
  assert.equal(getMessageHandoffSource(next.messages[1])?.taskAccepted, true);
  assert.equal(getMessageHandoffSource(evidence)?.taskAccepted, null);
});

test('continue preserves exact scope and plan and supplies feedback through existing pending input', async () => {
  const input = state();
  const next = apply(input, await node({ action: 'continue_current', feedback: 'Verify the saved document.' })(input, options));
  assert.equal(next.taskActiveDelegation?.id, 'd1');
  assert.equal(next.runNextDelegation?.contextSummary, 'Verify the saved document.');
  assert.equal(next.runNextDelegation?.task, input.taskActiveDelegation?.task);
  assert.deepEqual(next.runSupervisorSession?.plan, tail);
  assert.deepEqual(next.messages, input.messages);
});

test('acceptance with a question dispatches nothing and plan-only continuation seeds a fresh Entry', async () => {
  const input = state();
  const command = await node({ action: 'accept_result', reply: 'Choose a destination.', remainingPlan: tail })(input, options);
  const accepted = apply(input, command);
  assert.deepEqual(command.goto, ['answer']);
  assert.equal(accepted.runNextDelegation, null);
  assert.equal(accepted.taskActiveDelegation, null);
  assert.equal(accepted.runDelegationSummaries[0].status, 'completed');
  const terminal = await createAnswerNode({ models })(accepted, options);
  const finished = { ...accepted, ...terminal };
  assert.equal(finished.taskRunContinuation?.activeDelegationId, null);
  assert.deepEqual(finished.taskRunContinuation?.remainingPlan, tail);
  const resumed = { ...finished, ...buildRunStateReset({ activeDelegationTransition: 'resume_active' }) };
  Object.assign(resumed, applyActiveDelegationTransition(resumed));
  assert.equal(afterContextPrep(resumed), 'runSupervisor');
  let entry = false;
  await createRunSupervisorNode({ models, runSupervisorRunner: { invoke: async (input) => {
    entry = input.mode === 'entry';
    assert.deepEqual(input.remainingPlan, tail);
    assert.equal(input.userRequest, 'Prepare and publish.');
    return { reply: 'Ready to publish.' };
  } } })(resumed, options);
  assert.equal(entry, true);
});

test('plain final text preserves unfinished delegation and remaining plan', async () => {
  const input = state();
  const next = apply(input, await node({ reply: 'Please supply the missing source.' })(input, options));
  assert.deepEqual(next.taskActiveDelegation, input.taskActiveDelegation);
  assert.deepEqual(next.messages, input.messages);
  const terminal = await createAnswerNode({ models })(next, options);
  assert.equal(terminal.taskRunContinuation?.activeDelegationId, 'd1');
  assert.deepEqual(terminal.taskRunContinuation?.remainingPlan, tail);
});

test('Boundary without canonical evidence fails instead of accepting a preview', () => {
  const input = state(); input.messages = [new AIMessage('An ordinary assistant claim')];
  assert.throws(() => buildRunSupervisorInput({ nodeInput: input, supervisorSession: input.runSupervisorSession!,
    workspace: { rootPath: '/tmp', registryDigest: 'r', capabilityNames: ['general'], entries: [], reused: false },
  }), /requires typed result evidence/);
});

test('checkpoint recovery after root acceptance does not repeat acceptance or dispatch', async () => {
  const checkpointer = new MemorySaver(); let decisions = 0; let executions = 0;
  const supervisor = createRunSupervisorNode({ models, runSupervisorRunner: { invoke: async () => {
    decisions += 1; return { action: 'accept_result',  remainingPlan: tail };
  } } });
  const build = () => new StateGraph(OrchestratorState)
    .addNode('runSupervisor', supervisor, { ends: ['capability', 'answer'] })
    .addNode('capability', () => { executions += 1; return {}; })
    .addNode('answer', () => ({}))
    .addEdge(START, 'runSupervisor').addEdge('capability', END).addEdge('answer', END)
    .compile({ checkpointer });
  const config = { configurable: { registry, thread_id: 'boundary-replay' } };
  await build().invoke(state(), { ...config, interruptBefore: ['capability'] });
  assert.equal(decisions, 1); assert.equal(executions, 0);
  const restored = await build().invoke(null, config);
  assert.equal(decisions, 1); assert.equal(executions, 1);
  assert.equal(restored.messages.filter((m) => getDelegationAnnounce(m)).length, 1);
  assert.equal(restored.runDelegationSummaries[0].status, 'completed');
  await build().invoke(null, config);
  assert.equal(executions, 1);
});

test('old Announce checkpoints cannot silently become ordinary assistant claims', () => {
  const message = state().messages.at(-1)!;
  const metadata = message.additional_kwargs.pinpawo as { delegationAnnounce: { version: number } };
  metadata.delegationAnnounce.version = 2;
  assert.throws(() => projectDelegationAnnouncesForModel([message]), /checkpoint version is incompatible/);
});

test('a confirmed future-plan change continues the same unfinished delegation atomically', async () => {
  const input = state();
  input.runActiveDelegationTransition = 'resume_active';
  input.messages.push(setAgentMessageMetadata(new HumanMessage('取消后续发布，只完善当前文档。'), { runId: input.runId }));
  const next = apply(input, await node({ action: 'continue_current', remainingPlan: [], feedback: 'Complete the document.' })(input, options));
  assert.equal(next.taskActiveDelegation?.id, input.taskActiveDelegation?.id);
  assert.equal(next.taskActiveDelegation?.task, input.taskActiveDelegation?.task);
  assert.deepEqual(next.runSupervisorSession?.plan, []);
  assert.deepEqual(next.messages, input.messages);
  assert.equal(next.runNextDelegation?.contextSummary, 'Complete the document.');
});

test('execution cannot rewrite the plan or finish without a supplied reply', async () => {
  const input = state();
  for (const proposal of [
    { action: 'continue_current' as const, remainingPlan: [] },
    { action: 'accept_result' as const, remainingPlan: [{ capability: 'general', task: 'Unapproved extra task.' }] },
  ]) await assert.rejects(node(proposal)(input, options), /require fresh user confirmation/);
  input.runSupervisorSession = { ...input.runSupervisorSession!, plan: [] };
  await assert.rejects(node({ action: 'accept_result' })(input, options), /requires a final reply/);
  const accepted = apply(input, await node({ action: 'accept_result', reply: 'Document complete.' })(input, options));
  assert.equal(accepted.taskActiveDelegation, null);
  assert.equal(accepted.runSupervisorReply, 'Document complete.');
});

test('user-driven Boundary without results can clarify or continue, but cannot accept', async () => {
  const input = state(); input.messages = [setAgentMessageMetadata(new HumanMessage('Use the existing project.'), { runId: input.runId })];
  input.runActiveDelegationTransition = 'resume_active';
  input.taskActiveDelegation = { ...input.taskActiveDelegation!, status: 'pending' };
  await assert.rejects(node({ action: 'accept_result', reply: 'Done.' })(input, options), /without result evidence/);
  for (const result of [{ reply: 'Which project?' }, { action: 'continue_current' as const }]) {
    const next = apply(input, await node(result)(input, options));
    assert.equal(next.taskActiveDelegation?.id, input.taskActiveDelegation.id);
    assert.deepEqual(next.runSupervisorSession?.plan, tail);
  }
});
