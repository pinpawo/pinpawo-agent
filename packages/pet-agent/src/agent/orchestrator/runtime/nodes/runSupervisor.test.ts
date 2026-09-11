import assert from 'node:assert/strict';
import test from 'node:test';
import { AIMessage, HumanMessage, ToolMessage } from '@langchain/core/messages';
import { Command, messagesStateReducer } from '@langchain/langgraph';
import type { AgentModels } from '../../../../types/agent';
import { defineInstructionDocument } from '../../../../types/capability';
import { setAgentMessageMetadata, queryAgentMessages } from '../../../messages';
import { compileAgentRegistry } from '../../registry';
import { buildRunStateReset, type OrchestratorStateType } from '../../state';
import { createRunSupervisorNode } from './runSupervisor';
import { createAnswerNode } from './answer';
import { buildRunSupervisorInput } from '../../runSupervisor/input';
import { createCapabilityCatalog } from '../../runSupervisor/capabilityCatalog';
import { createCapabilityDisclosureState } from '../../runSupervisor/capabilityDisclosure';
import { withScriptedDelegation, scriptedSupervisorResult } from '../../runSupervisor/testing';
import type { SupervisorControl } from '../../runSupervisor/messageHandoff';
import { readCapabilityCall, capabilityResultMessage } from '../delegationToolResult';

const models = { act: { invoke: () => { throw new Error('Unexpected model call'); } } } as unknown as AgentModels;
const registry = compileAgentRegistry({ toolkits: [], capabilities: [{
  name: 'general', description: 'Execute work.', uses: [],
  instructions: defineInstructionDocument({ content: 'Execute the requested task.' }),
}] });
const options = { configurable: { registry } };
const tasks = [{ capability: 'general', task: 'Prepare the document.' }, { capability: 'general', task: 'Publish it.' }];
function state(): OrchestratorStateType {
  return { ...buildRunStateReset(), runId: 'r1', traceId: 't1', runUserRequest: 'Prepare and publish.',
    runSupervisorState: { goal: null, plan: [] },
    messages: [new HumanMessage({ id: 'human', content: 'Prepare and publish.' }),
      new AIMessage({ content: '', tool_calls: [{ id: 'entry', name: 'plan_request', args: { goal: 'Prepare and publish.' } }] }),
      new ToolMessage({ name: 'plan_request', tool_call_id: 'entry', content: 'Handed off.' }),
    ].map((message) => setAgentMessageMetadata(message, { runId: 'r1', traceId: 't1' })),
    sessionCapabilityArtifacts: [], sessionToolAuthorizations: { generation: '', records: [] },
  };
}
function node(decision: SupervisorControl | { reply: string }) {
  return createRunSupervisorNode({ models, runSupervisorRunner: withScriptedDelegation({ invoke: async () => decision }) });
}
function apply(input: OrchestratorStateType, command: Command): OrchestratorStateType {
  const update = command.update as Partial<OrchestratorStateType>;
  return { ...input, ...update, messages: messagesStateReducer(input.messages, update.messages ?? []) };
}
async function delivered() {
  const initial = state();
  const planned = apply(initial, await node({ name: 'submit_plan', args: { tasks } })(initial, options));
  const call = readCapabilityCall(planned);
  const delivery = { id: 'delivery', task: call.task, text: 'Draft saved; publication has not run.', scope: {
    lane: 'capability:general' as const, runId: planned.runId, traceId: planned.traceId, delegationId: call.delegationId,
  } };
  return { ...planned, messages: [...planned.messages, capabilityResultMessage(planned, call, { status: 'returned', delivery, artifacts: [] })] };
}

test('control handoff goes straight to Capability with separate main and work records', async () => {
  const input = state();
  const command = await node({ name: 'submit_plan', args: { tasks } })(input, options);
  const next = apply(input, command);
  assert.deepEqual(command.goto, ['capability']);
  assert.equal(next.runSupervisorState.plan[0].status, 'pending');
  assert.equal(readCapabilityCall(next).task, tasks[0].task);
  assert.equal(queryAgentMessages(next.messages).supervisor(next.runId).select().messages.length, 2);
  for (const key of ['proposal', 'pendingCall', 'nextAttempt', 'activeDelegation', 'messages', 'run']) {
    assert.equal(key in next.runSupervisorState, false);
  }
});

test('review accepts only current task and dispatches the next without another Supervisor call', async () => {
  const input = await delivered();
  const command = await node({ name: 'review_current', args: { completed: true, reason: 'Draft verified.' } })(input, options);
  const next = apply(input, command);
  assert.deepEqual(command.goto, ['capability']);
  assert.deepEqual(next.runSupervisorState.plan.map((task) => task.status), ['completed', 'pending']);
  assert.equal(readCapabilityCall(next).task, tasks[1].task);
  assert.ok(next.messages.includes(input.messages.at(-1)!));
});

test('retry derives same-run execution identity and carries feedback in the actual call', async () => {
  const input = await delivered();
  const command = await node({ name: 'review_current', args: { completed: false, reason: 'Verify the document.' } })(input, options);
  const call = readCapabilityCall(apply(input, command));
  const previous = input.messages.filter((m) => AIMessage.isInstance(m) && m.tool_calls?.[0]?.name === 'delegate_capability').at(-1) as AIMessage;
  assert.equal(call.delegationId, previous.tool_calls![0].args.execution.delegationId);
  assert.equal(call.mode, 'continue');
  assert.equal(call.guidance, 'Verify the document.');
});

test('accepted A and pending B survive an answer and new run without a continuation object', async () => {
  const input = await delivered();
  const accepted = apply(input, await node({ name: 'review_current', args: { completed: true,
    reason: 'Draft verified.', reply: 'Choose a destination.' } })(input, options));
  const terminal = await createAnswerNode()(accepted);
  const resumed = { ...accepted, ...terminal, messages: messagesStateReducer(accepted.messages, terminal.messages),
    ...buildRunStateReset() };
  assert.deepEqual(resumed.runSupervisorState.plan.map((task) => task.status), ['completed', 'pending']);
  const next = apply(resumed, await node({ name: 'review_current', args: { reason: 'Proceed with publication.' } })(
    { ...resumed, runUserRequest: 'Publish now.' }, options));
  assert.equal(readCapabilityCall(next).task, tasks[1].task);
  assert.equal(readCapabilityCall(next).mode, 'initial');
});

test('natural question does not accept the returned task or erase its results', async () => {
  const input = await delivered();
  const next = apply(input, await node({ reply: 'Which destination?' })(input, options));
  assert.deepEqual(next.runSupervisorState, input.runSupervisorState);
  assert.equal((await createAnswerNode()(next)).messages[0].text, 'Which destination?');
});

test('new user input is consumed once, including guidance added within a native resumed run', async () => {
  const input = await delivered();
  const guidance = setAgentMessageMetadata(new HumanMessage({ id: 'guidance', content: 'Change destination.' }),
    { runId: input.runId, traceId: input.traceId });
  input.messages.push(guidance);
  const catalog = createCapabilityCatalog({ registry });
  const build = (root: OrchestratorStateType) => buildRunSupervisorInput({ root, catalog,
    capabilityDisclosure: createCapabilityDisclosureState({ catalog }) });
  assert.equal(build(input).inputId, 'human:guidance');
  assert.ok(!build({ ...input, runSupervisorUserMessageId: 'human:guidance' }).inputId.startsWith('human:'));
});

test('Root rejects changed handoff arguments and decisions without actual internal confirmation', async () => {
  const input = state();
  const runner = createRunSupervisorNode({ models, runSupervisorRunner: { invoke: async (invocation) => {
    const result = scriptedSupervisorResult(invocation, { name: 'submit_plan', args: { tasks } });
    const dispatch = result.messages.at(-1) as AIMessage;
    dispatch.tool_calls![0].args.execution.task = 'Tampered task.';
    return result;
  } } });
  await assert.rejects(runner(input, options), /does not match/);
  await assert.rejects(node({ name: 'submit_plan', args: { tasks: [{ capability: 'missing', task: 'Do it.' }] } })(
    input, options), /outside/);
});

test('accepting a pending task without returned evidence is rejected', async () => {
  const input = state();
  const pending = apply(input, await node({ name: 'submit_plan', args: { tasks } })(input, options));
  await assert.rejects(node({ name: 'review_current', args: { completed: true, reason: 'No evidence.' } })(pending, options), /returned delivery/);
});
