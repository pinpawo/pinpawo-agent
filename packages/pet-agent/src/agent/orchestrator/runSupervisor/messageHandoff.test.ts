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
import { identity, type SupervisorHandoffContext } from './controlContext';
import { supervisorWorkMessages } from './messageHandoff';
import { readCapabilityExecutions } from '../executionMessages';
import { createRunSupervisorProbe } from './testing';
import { createCapabilityCatalog } from './capabilityCatalog';
import { createCapabilityDisclosureState } from './capabilityDisclosure';
import { compileAgentRegistry } from '../registry';
import { defineInstructionDocument } from '../../../types/capability';

const taskA = { capability: 'general', objective: 'Inspect A.' };
const taskB = { capability: 'general', objective: 'Inspect B.' };
function context(overrides: Partial<SupervisorHandoffContext> = {}): SupervisorHandoffContext {
  return { state: { runId: null, goal: null, plan: [] }, runId: 'r1', taskId: 't1', userRequest: 'Inspect the project.',
    mode: 'entry', hasNewUserInput: true, allowedCapabilityNames: ['general'], messages: [], ...overrides };
}
function control(name: string, args: Record<string, unknown>, id: string) {
  return new AIMessage({ id: `request:${id}`, content: '', tool_calls: [{ name, args, id, type: 'tool_call' }] });
}
function dispatchResult(input: SupervisorHandoffContext, id = 'execute-first') {
  return { runSupervisorState: input.state, messages: supervisorWorkMessages(input, [control('delegate_capability', { briefing: 'Execute the current objective.' }, id)], true) };
}
function resultFor(input: SupervisorHandoffContext, dispatch: AIMessage) {
  const execution = buildCapabilityExecutionInput(input, { briefing: 'Execute current objective.' });
  const metadata = getAgentMessageMetadata(dispatch);
  return setAgentMessageMetadata(new ToolMessage({ name: 'delegate_capability', tool_call_id: dispatch.tool_calls![0].id!,
    artifact: execution, content: JSON.stringify({ status: 'returned', delivery: {
      id: 'delivery', task: execution.task, text: 'Verified execution evidence.', scope: {
        runId: metadata.runId, taskId: metadata.taskId, delegationId: execution.delegationId, lane: `capability:${execution.capability}`,
      },
    }, artifacts: [] }),
  }), metadata);
}
function returned() {
  const initial = context();
  const input = { ...initial, state: submitPlan(initial, { tasks: [taskA, taskB] }, 'plan') };
  const dispatch = dispatchResult(input).messages[0] as AIMessage;
  return { ...input, mode: 'boundary' as const, messages: [dispatch, resultFor(input, dispatch)] };
}

test('acceptance uses the latest returned delivery and ignores mismatched or private evidence', () => {
  const first = returned();
  const original = first.messages.at(-1) as ToolMessage;
  for (const mutate of [
    (m: ToolMessage) => { setAgentMessageMetadata(m, { lane: 'capability:general' }); },
    (m: ToolMessage) => { setAgentMessageMetadata(m, { runId: 'other-run' }); },
    (m: ToolMessage) => { m.tool_call_id = 'other-call'; },
    (m: ToolMessage) => { m.status = 'error'; },
    (m: ToolMessage) => { m.content = '{invalid'; },
    (m: ToolMessage) => { const data = JSON.parse(m.text); data.delivery.scope.delegationId = 'other'; m.content = JSON.stringify(data); },
  ]) {
    const message = new ToolMessage({ ...original });
    mutate(message);
    assert.throws(() => reviewCurrent({ ...first, messages: [...first.messages.slice(0, -1), message] },
      { completed: true, reason: 'Accept' }), /returned delivery/);
  }
  const retry = dispatchResult(first, 'retry');
  const dispatch = retry.messages.at(-1) as AIMessage;
  for (const status of ['missing_deliverable', 'paused']) {
    const failure = setAgentMessageMetadata(new ToolMessage({ name: 'delegate_capability', tool_call_id: dispatch.tool_calls![0].id!,
      artifact: buildCapabilityExecutionInput(first, { briefing: 'Execute current objective.' }), content: JSON.stringify({ status, delivery: null, artifacts: [] }),
    }), getAgentMessageMetadata(dispatch));
    const input = { ...first, messages: [...first.messages, ...retry.messages, failure] };
    assert.throws(() => reviewCurrent(input, { completed: true, reason: 'Old evidence' }), /returned delivery/);
    assert.ok(buildCapabilityExecutionInput(input, { briefing: 'Execute current objective.' }));
  }
});

test('same-run retries retain execution scope; new runs start a new delegation', () => {
  const input = returned();
  const before = readCapabilityExecutions(input.messages)[0].execution;
  const retry = buildCapabilityExecutionInput(input, { briefing: 'Continue work.' }, 'Missing evidence');
  const fresh = buildCapabilityExecutionInput({ ...input, runId: 'r2' }, { briefing: 'Continue work.' }, 'Missing evidence');
  assert.equal(retry.mode, 'continue');
  assert.equal(retry.delegationId, before.delegationId);
  assert.equal(fresh.mode, 'initial');
  assert.notEqual(fresh.delegationId, before.delegationId);
  assert.equal(fresh.briefing, retry.briefing);
  assert.equal(retry.briefing, 'Continue work.\n\nReview feedback:\nMissing evidence');
});

test('adjustment preserves completed work, supersedes replaced executions and checks goal changes', () => {
  const input = returned();
  const completed = reviewCurrent(input, { completed: true, reason: 'Verified' });
  const next = { ...input, state: completed, hasNewUserInput: false };
  const args = { goal: input.userRequest, reason: 'Use A evidence', currentDelegation: 'continue' as const, tasks: [taskB] };
  const revised = adjustPlan(next, args, 'adjust');
  assert.equal(revised.plan[0].status, 'completed');
  assert.equal(revised.plan[1].id, completed.plan[1].id);
  assert.throws(() => adjustPlan(next, { ...args, goal: 'Different' }, 'adjust'), /fresh user/);
  assert.equal(adjustPlan({ ...next, hasNewUserInput: true }, { ...args, goal: 'Different' }, 'adjust').goal, 'Different');
  const replaced = adjustPlan(input, { ...args, currentDelegation: 'replace' }, 'replace');
  assert.deepEqual(replaced.plan.map(t => t.status), ['superseded', 'pending']);
  assert.equal(replaced.plan[0].id, input.state.plan[0].id);
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
async function probe(input: SupervisorHandoffContext, responses: AIMessage[]) {
  const model = new Model(responses);
  const result = await createRunSupervisorProbe({ model }).invoke({
    ...input, inputId: input.hasNewUserInput ? 'human:input' : 'boundary:input', catalog,
    capabilityDisclosure: createCapabilityDisclosureState({ catalog }),
  });
  return { result, model };
}

test('native parent handoff carries updated plan and feedback without a fake result', async () => {
  const input = returned();
  const { result, model } = await probe(input, [
    control('review_current', { completed: false, reason: 'Verify missing evidence' }, 'review'),
    control('delegate_capability', { briefing: 'Execute the current objective.' }, 'execute'),
  ]);
  assert.equal(model.inputs.length, 2);
  assert.equal(result.reviewFeedback, 'Verify missing evidence');
  assert.deepEqual(result.runSupervisorState, input.state);
  assert.equal(result.messages.some(m => ToolMessage.isInstance(m) && m.name === 'delegate_capability'), false);
  assert.equal(getAgentMessageMetadata(result.messages.at(-1)!).execution, undefined);
});

test('review then adjustment shares current state and clears feedback before native handoff', async () => {
  const input = returned();
  const { result } = await probe(input, [
    control('review_current', { completed: true, reason: 'A verified' }, 'review'),
    control('adjust_plan', { goal: input.userRequest, reason: 'Use A evidence', currentDelegation: 'continue', tasks: [taskB] }, 'adjust'),
    control('delegate_capability', { briefing: 'Execute the current objective.' }, 'execute'),
  ]);
  assert.deepEqual(result.runSupervisorState.plan.map(t => t.status), ['completed', 'pending']);
  assert.equal(result.reviewFeedback, null);
});

test('a natural question commits the plan without dispatching it', async () => {
  const { result } = await probe(context(), [control('submit_plan', { tasks: [taskA] }, 'plan'), new AIMessage('Which destination?')]);
  assert.equal(supervisorReply(result), 'Which destination?');
  assert.equal(result.runSupervisorState.plan[0].status, 'pending');
  assert.deepEqual(queryAgentMessages(result.messages).main().select().messages.map(m => m.text), ['Which destination?']);
});

test('correcting delegation arguments preserves the rejected delivery feedback', async () => {
  const { result, model } = await probe(returned(), [
    control('review_current', { completed: false, reason: 'Verify missing evidence' }, 'review'),
    control('delegate_capability', { planItemId: 'invented' }, 'invalid'),
    control('delegate_capability', { briefing: 'Execute the current objective.' }, 'corrected'),
  ]);
  assert.equal(model.inputs.length, 3);
  assert.equal(result.reviewFeedback, 'Verify missing evidence');
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


test('plan continuation retains task history and replacement starts without it', () => {
  const input = returned();
  const delegation = { id: 'd', runId: input.runId, taskId: input.taskId, messages: [new AIMessage('Private work')] };
  input.state.plan[0].delegation = delegation;
  const args = { goal: input.userRequest, reason: 'More verification', tasks: [taskA] };
  const continued = adjustPlan(input, { ...args, currentDelegation: 'continue' }, 'continue');
  assert.equal(continued.plan[0].delegation, delegation);
  const replaced = adjustPlan(input, { ...args, currentDelegation: 'replace' }, 'replace');
  assert.equal(replaced.plan[0].delegation, delegation);
  assert.equal(replaced.plan[0].status, 'superseded');
  assert.equal(replaced.plan[1].delegation, undefined);
});
