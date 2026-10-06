import { supervisorReply } from './testing';
import assert from 'node:assert/strict';
import test from 'node:test';
import { AIMessage, ToolMessage, type BaseMessage } from '@langchain/core/messages';
import { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { getAgentMessageMetadata, setAgentMessageMetadata, queryAgentMessages } from '../../messages';
import { submitPlan } from './submitPlanTool';
import { reviewCurrent } from './reviewCurrentTool';
import { adjustPlan } from './adjustPlanTool';
import { buildCapabilityExecutionInput } from './delegateCapabilityTool';
import { identity, type SupervisorControlContext } from './controlContext';
import { supervisorWorkMessages } from './workMessages';
import { createCapabilityExecutionMessage, readCapabilityExecutions, type CapabilityExecutionRecord } from '../executionMessages';
import { createRunSupervisorProbe } from './testing';
import { createCapabilityCatalog } from './capabilityCatalog';
import { createCapabilityDisclosureState } from './capabilityDisclosure';
import { compileAgentRegistry } from '../registry';
import { defineInstructionDocument } from '../../../types/capability';

const taskA = { capability: 'general', objective: 'Inspect A.' };
const taskB = { capability: 'general', objective: 'Inspect B.' };
function context(overrides: Partial<SupervisorControlContext> = {}): SupervisorControlContext {
  return { state: { runId: null, goal: null, plan: [] }, runId: 'r1', taskId: 't1', userRequest: 'Inspect the project.',
    mode: 'entry', hasNewUserInput: true, allowedCapabilityNames: ['general'], messages: [], ...overrides };
}
function control(name: string, args: Record<string, unknown>, id: string) {
  return new AIMessage({ id: `request:${id}`, content: '', tool_calls: [{ name, args, id, type: 'tool_call' }] });
}
function dispatchResult(input: SupervisorControlContext, id = 'execute-first') {
  return { runSupervisorState: input.state, messages: supervisorWorkMessages(input, [control('delegate_capability', { briefing: 'Execute the current objective.' }, id)], true) };
}
function resultFor(input: SupervisorControlContext, dispatch: AIMessage) {
  const execution = buildCapabilityExecutionInput(input, { briefing: 'Execute current objective.' }, dispatch.tool_calls![0].id!);
  const metadata = getAgentMessageMetadata(dispatch);
  return createCapabilityExecutionMessage({ callId: dispatch.tool_calls![0].id!, execution, metadata,
    result: { status: 'returned', artifacts: [], delivery: {
      id: 'delivery', task: execution.task, text: 'Verified execution evidence.', scope: {
        runId: metadata.runId as string, taskId: metadata.taskId as string, delegationId: execution.delegationId, lane: `capability:${execution.capability}`,
      },
    } } });
}
function returned() {
  const initial = context();
  const input = { ...initial, state: submitPlan(initial, { tasks: [taskA, taskB] }, 'plan') };
  const dispatch = dispatchResult(input).messages[0] as AIMessage;
  return { ...input, mode: 'boundary' as const, messages: [dispatch, resultFor(input, dispatch)] };
}

test('acceptance ignores results that are not this call\'s main record and rejects corrupted ones', () => {
  const first = returned();
  const original = first.messages.at(-1) as ToolMessage;
  const withResult = (mutate: (m: ToolMessage) => void) => {
    const message = new ToolMessage({ ...original });
    mutate(message);
    return { ...first, messages: [...first.messages.slice(0, -1), message] };
  };
  for (const mutate of [
    (m: ToolMessage) => { setAgentMessageMetadata(m, { lane: 'capability:general' }); },
    (m: ToolMessage) => { setAgentMessageMetadata(m, { runId: 'other-run' }); },
    (m: ToolMessage) => { m.tool_call_id = 'other-call'; },
  ]) {
    assert.throws(() => reviewCurrent(withResult(mutate), { completed: true, reason: 'Accept' }), /returned delivery/);
  }
  const record = original.artifact as CapabilityExecutionRecord & { kind: 'executed' };
  for (const mutate of [
    (m: ToolMessage) => { m.status = 'error'; },
    (m: ToolMessage) => { m.artifact = { ...record, execution: { ...record.execution, delegationId: 'other' } }; },
    (m: ToolMessage) => { m.artifact = record.execution; },
  ]) {
    assert.throws(() => reviewCurrent(withResult(mutate), { completed: true, reason: 'Accept' }), /Corrupted delegate_capability record/);
  }
  // Content is only the model-facing rendering; readers never depend on it.
  assert.ok(reviewCurrent(withResult((m) => { m.content = '{invalid'; }), { completed: true, reason: 'Accept' }));
  const retry = dispatchResult(first, 'retry');
  const dispatch = retry.messages.at(-1) as AIMessage;
  for (const status of ['missing_deliverable'] as const) {
    const failure = createCapabilityExecutionMessage({ callId: dispatch.tool_calls![0].id!,
      execution: buildCapabilityExecutionInput(first, { briefing: 'Execute current objective.' }, dispatch.tool_calls![0].id!),
      result: { status, delivery: null, artifacts: [] }, metadata: getAgentMessageMetadata(dispatch) });
    const input = { ...first, messages: [...first.messages, ...retry.messages, failure] };
    assert.throws(() => reviewCurrent(input, { completed: true, reason: 'Old evidence' }), /returned delivery/);
    assert.ok(buildCapabilityExecutionInput(input, { briefing: 'Execute current objective.' }, 'next-call'));
  }
});

test('each tool call has its own execution identity and preserves the model briefing verbatim', () => {
  const input = returned();
  const before = readCapabilityExecutions(input.messages)[0].execution;
  const args = { briefing: 'Use the returned evidence; verify the missing detail only.' };
  const next = buildCapabilityExecutionInput(input, args, 'next-call');
  const retry = buildCapabilityExecutionInput(input, args, 'next-call');
  const fresh = buildCapabilityExecutionInput({ ...input, runId: 'r2' }, args, 'next-call');
  assert.notEqual(next.delegationId, before.delegationId);
  assert.equal(retry.delegationId, next.delegationId, 'native replay of the same call preserves identity');
  assert.notEqual(fresh.delegationId, next.delegationId);
  assert.equal(next.briefing, args.briefing);
  assert.equal('mode' in next, false);
});

test('adjustment preserves completed work, supersedes replaced executions and checks goal changes', () => {
  const input = returned();
  const completed = reviewCurrent(input, { completed: true, reason: 'Verified' });
  const next = { ...input, state: completed, hasNewUserInput: false };
  const args = { goal: input.userRequest, reason: 'Use A evidence', currentTask: 'keep' as const, tasks: [taskB] };
  const revised = adjustPlan(next, args, 'adjust');
  assert.equal(revised.plan[0].status, 'completed');
  assert.equal(revised.plan[1].id, completed.plan[1].id);
  assert.throws(() => adjustPlan(next, { ...args, goal: 'Different' }, 'adjust'), /fresh user/);
  assert.equal(adjustPlan({ ...next, hasNewUserInput: true }, { ...args, goal: 'Different' }, 'adjust').goal, 'Different');
  const replaced = adjustPlan(input, { ...args, currentTask: 'replace' }, 'replace');
  assert.deepEqual(replaced.plan.map(t => t.status), ['superseded', 'pending']);
  assert.equal(replaced.plan[0].id, input.state.plan[0].id);
});

test('a boundary re-plan keeps the established goal instead of the run request', () => {
  const carried = { runId: 'r1', goal: 'Refactor the parser.', plan: [{ ...taskA, id: 'old', status: 'completed' as const }] };
  // Entry establishes the goal from this run's resolved request.
  assert.equal(submitPlan(context({ state: carried }), { tasks: [taskB] }, 'entry').goal, 'Inspect the project.');
  // After continue the run request is just the continuation utterance.
  const continued = context({ state: carried, mode: 'boundary', userRequest: '继续' });
  assert.equal(submitPlan(continued, { tasks: [taskB] }, 'boundary').goal, 'Refactor the parser.');
  assert.equal(submitPlan({ ...continued, hasNewUserInput: false }, { tasks: [taskB] }, 'later').goal, 'Refactor the parser.');
});

test('review fails the run when a planned task has lost its goal', () => {
  const input = returned();
  assert.throws(() => reviewCurrent({ ...input, state: { ...input.state, goal: null } }, { completed: false, reason: 'Retry' }),
    /no goal/);
  assert.throws(() => reviewCurrent({ ...input, state: { runId: 'r1', goal: null, plan: [] } }, { completed: false, reason: 'Retry' }),
    /no task to review/, 'a missing plan stays a correctable decision');
});

test('work projection scopes delegation IDs per run without changing arguments or the original message', () => {
  const request = control('delegate_capability', { briefing: 'Execute the current objective.' }, 'native-call');
  const projected = supervisorWorkMessages(context(), [request], true);
  const projectedCall = (projected[0] as AIMessage).tool_calls![0];
  assert.equal(projectedCall.id, identity('call', context().runId, 'native-call'));
  assert.deepEqual(projectedCall.args, request.tool_calls![0].args);
  assert.equal(request.tool_calls![0].id, 'native-call');
  assert.notEqual((supervisorWorkMessages(context({ runId: 'other' }), [request], true)[0] as AIMessage).tool_calls![0].id, projectedCall.id);
  assert.equal(getAgentMessageMetadata(projected[0]).execution, undefined);
  assert.equal(queryAgentMessages(projected).main().select().messages.length, 1);
});

class Model extends BaseChatModel {
  readonly inputs: BaseMessage[][] = [];
  constructor(private readonly responses: AIMessage[]) { super({}); }
  _llmType() { return 'native-supervisor-decisions'; }
  bindTools() { return this; }
  async _generate(messages: BaseMessage[]) {
    const message = this.responses[this.inputs.length];
    assert.ok(message, 'unexpected extra model turn');
    this.inputs.push(messages);
    return { generations: [{ message, text: message.text }] };
  }
}
const catalog = createCapabilityCatalog({ registry: compileAgentRegistry({ toolkits: [], capabilities: [{
  name: 'general', description: 'Inspect', uses: [], instructions: defineInstructionDocument({ content: 'Inspect and report.' }),
}] }) });
async function probe(input: SupervisorControlContext, responses: AIMessage[]) {
  const model = new Model(responses);
  const result = await createRunSupervisorProbe({ model }).invoke({
    ...input, inputId: input.hasNewUserInput ? 'human:input' : 'boundary:input', catalog,
    capabilityDisclosure: createCapabilityDisclosureState({ catalog }),
  });
  return { result, model };
}

test('native parent handoff carries updated plan and model briefing without a fake result', async () => {
  const input = returned();
  const { result, model } = await probe(input, [
    control('review_current', { completed: false, reason: 'Verify missing evidence' }, 'review'),
    control('delegate_capability', { briefing: 'Execute the current objective.' }, 'execute'),
  ]);
  assert.equal(model.inputs.length, 2);
  assert.ok(model.inputs.at(-1)!.some(message => AIMessage.isInstance(message)
    && message.tool_calls?.some(call => call.name === 'review_current' && call.args.reason === 'Verify missing evidence')));
  assert.deepEqual(result.runSupervisorState, input.state);
  assert.equal(result.messages.some(m => ToolMessage.isInstance(m) && m.name === 'delegate_capability'), false);
  assert.equal(getAgentMessageMetadata(result.messages.at(-1)!).execution, undefined);
});

test('review then adjustment shares current plan state before native handoff', async () => {
  const input = returned();
  const { result } = await probe(input, [
    control('review_current', { completed: true, reason: 'A verified' }, 'review'),
    control('adjust_plan', { goal: input.userRequest, reason: 'Use A evidence', currentTask: 'keep', tasks: [taskB] }, 'adjust'),
    control('delegate_capability', { briefing: 'Execute the current objective.' }, 'execute'),
  ]);
  assert.deepEqual(result.runSupervisorState.plan.map(t => t.status), ['completed', 'pending']);
});

test('a natural question commits the plan without dispatching it', async () => {
  const { result } = await probe(context(), [control('submit_plan', { tasks: [taskA] }, 'plan'), new AIMessage('Which destination?')]);
  assert.equal(supervisorReply(result), 'Which destination?');
  assert.equal(result.runSupervisorState.plan[0].status, 'pending');
  assert.deepEqual(queryAgentMessages(result.messages).main().select().messages.map(m => m.text), ['Which destination?']);
});

test('correcting delegation arguments preserves the review conversation', async () => {
  const { result, model } = await probe(returned(), [
    control('review_current', { completed: false, reason: 'Verify missing evidence' }, 'review'),
    control('delegate_capability', { planItemId: 'invented' }, 'invalid'),
    control('delegate_capability', { briefing: 'Execute the current objective.' }, 'corrected'),
  ]);
  assert.equal(model.inputs.length, 3);
  assert.ok(model.inputs.at(-1)!.some(message => AIMessage.isInstance(message)
    && message.tool_calls?.some(call => call.name === 'review_current' && call.args.reason === 'Verify missing evidence')));
  const error = result.messages.find(m => ToolMessage.isInstance(m) && m.tool_call_id === identity('call', context().runId, 'invalid')) as ToolMessage;
  assert.equal(error.status, 'error');
});


test('final publication preserves structured model content and usage without a private reply copy', async () => {
  const content = [{ type: 'text' as const, text: '  Choose a destination.  ' }];
  const usage = { input_tokens: 12, output_tokens: 4, total_tokens: 16 };
  const { result } = await probe(context(), [new AIMessage({ id: 'final-model', content, usage_metadata: usage })]);
  assert.equal(result.messages.length, 1);
  const message = result.messages[0] as AIMessage;
  assert.deepEqual(message.content, content);
  assert.deepEqual(message.usage_metadata, usage);
  assert.equal(message.id, identity('supervisor-message', context().runId, 'final-model'));
  assert.equal(queryAgentMessages(result.messages).main().select().messages[0], message);
  assert.equal(queryAgentMessages(result.messages).supervisor(context().runId).select().messages.length, 0);
});
