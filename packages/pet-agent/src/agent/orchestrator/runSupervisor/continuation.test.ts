import assert from 'node:assert/strict';
import test from 'node:test';
import { AIMessage, HumanMessage, ToolMessage, type BaseMessage } from '@langchain/core/messages';
import { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { MemorySaver } from '@langchain/langgraph';
import { getAgentMessageMetadata, setAgentMessageMetadata } from '../../messages';
import {
  createCapabilityExecutionMessage,
  createRejectedCapabilityExecutionMessage,
  readCapabilityExecutions,
} from '../executionMessages';
import { isDelegationBriefingMessage, materializeDelegation } from '../delegation';
import { createOrchestratorGraph } from '../runtime/graph';
import { buildOrchestratorRunInput } from '../state';
import { compileAgentRegistry } from '../registry';
import { defineInstructionDocument } from '../../../types/capability';
import { buildCapabilityExecutionInput, type DelegateCapabilityArgs } from './delegateCapabilityTool';
import { SupervisorDecisionError, type SupervisorControlContext } from './controlContext';
import { submitPlan } from './submitPlanTool';
import { adjustPlan } from './adjustPlanTool';
import { supervisorWorkMessages } from './workMessages';

const task = { capability: 'general', objective: 'Inspect and verify the repository.' };
const originalBriefing = '  Read the evidence.\nPreserve ticket="opaque-42" and the original diagnostic ]]> exactly.\nVerify the missing result.\n';

function planned(): SupervisorControlContext {
  const context: SupervisorControlContext = {
    state: { runId: null, goal: null, plan: [] },
    runId: 'continuation-run', taskId: 'continuation-task', userRequest: 'Inspect and verify, then return the evidence.',
    mode: 'entry', allowedCapabilityNames: ['general'], messages: [],
  };
  return { ...context, state: submitPlan(context, { tasks: [task] }, 'plan') };
}

function record(context: SupervisorControlContext, args: DelegateCapabilityArgs, callId: string, text: string | null) {
  const execution = buildCapabilityExecutionInput(context, args, callId);
  const [request] = supervisorWorkMessages(context, [new AIMessage({
    id: `request:${callId}`, content: '', tool_calls: [{ id: callId, name: 'delegate_capability', args, type: 'tool_call' }],
  })], true);
  const metadata = getAgentMessageMetadata(request);
  const result = createCapabilityExecutionMessage({ callId, execution, metadata,
    result: text === null ? { status: 'missing_deliverable', delivery: null } : {
      status: 'returned', delivery: {
        id: `delivery:${callId}`, task: execution.task, text,
        scope: { runId: context.runId, taskId: context.taskId, delegationId: execution.delegationId, lane: 'capability:general' },
      },
    },
  });
  return { execution, context: { ...context, mode: 'boundary' as const, messages: [...context.messages, request, result] } };
}

test('three executions reuse the exact briefing and refer only to the immediate prior execution', () => {
  const first = record(planned(), { briefing: originalBriefing }, 'first', 'Read completed; verification is pending.');
  const second = record(first.context, { continue: true }, 'second', 'Verification is running.');
  const third = record(second.context, { continue: true }, 'third', 'Verification completed.');
  assert.equal(first.execution.continuation, undefined);
  assert.deepEqual(second.execution.continuation,
    { delegationId: first.execution.delegationId, deliveryId: 'delivery:first' });
  assert.deepEqual(third.execution.continuation,
    { delegationId: second.execution.delegationId, deliveryId: 'delivery:second' });
  const executions = readCapabilityExecutions(third.context.messages);
  assert.equal(new Set(executions.map(item => item.execution.delegationId)).size, 3);
  assert.equal(new Set(executions.map(item => item.execution.planItemId)).size, 1);
  for (const { execution } of executions) {
    assert.equal(execution.briefing, originalBriefing);
    assert.equal(execution.goal, first.execution.goal);
  }
  assert.deepEqual(buildCapabilityExecutionInput(third.context, { continue: true }, 'third'), third.execution,
    'native replay must not use its own persisted execution as the previous source');
});

test('continuing a missing-deliverable execution preserves instructions without inventing a handoff', () => {
  const first = record(planned(), { briefing: originalBriefing }, 'failed', null);
  const next = buildCapabilityExecutionInput(first.context, { continue: true }, 'retry');
  assert.equal(next.briefing, originalBriefing);
  assert.deepEqual(next.continuation, { delegationId: first.execution.delegationId, deliveryId: null });
  const message = materializeDelegation({ userRequest: next.goal, task: next.task, briefing: next.briefing,
    continuation: next.continuation });
  assert.equal(message.text.includes('<previous_delivery_id>'), false);
  assert.equal(readCapabilityExecutions(first.context.messages)[0].result.delivery, null);
});

test('continuation requires an actual execution, not an unpaired or rejected request', () => {
  const initial = planned();
  const callId = 'rejected';
  const [request] = supervisorWorkMessages(initial, [new AIMessage({ content: '',
    tool_calls: [{ id: callId, name: 'delegate_capability', args: { briefing: 'Rejected instructions.' }, type: 'tool_call' }],
  })], true);
  const rejected = createRejectedCapabilityExecutionMessage({ callId, content: 'Not executed.', metadata: getAgentMessageMetadata(request) });
  for (const messages of [[], [request], [request, rejected]]) {
    assert.throws(() => buildCapabilityExecutionInput({ ...initial, messages }, { continue: true }, 'retry'), SupervisorDecisionError);
  }
  const first = record(initial, { briefing: originalBriefing }, 'first', 'Partial evidence.');
  const next = buildCapabilityExecutionInput({ ...first.context, messages: [...first.context.messages, request, rejected] },
    { continue: true }, 'retry');
  assert.equal(next.briefing, originalBriefing);
  assert.equal(next.continuation?.delegationId, first.execution.delegationId);
});

test('a continued execution never falls back to another plan item or a changed task boundary', () => {
  const first = record(planned(), { briefing: originalBriefing }, 'first', 'Partial evidence.');
  const item = first.context.state.plan[0];
  for (const replacement of [
    { ...item, id: 'another-task' },
    { ...item, capability: 'other' },
    { ...item, objective: 'Prepare a release instead.' },
  ]) {
    assert.throws(() => buildCapabilityExecutionInput({ ...first.context, allowedCapabilityNames: ['general', 'other'],
      state: { ...first.context.state, plan: [replacement] } }, { continue: true }, 'retry'), SupervisorDecisionError);
  }
  const changed = adjustPlan(first.context, { reason: 'Calibrate the acceptance target.', currentTask: 'keep',
    adjustedGoal: 'Inspect without verification.', tasks: [task] }, 'calibrate');
  assert.equal(changed.plan[0].id, item.id);
  const calibrated = { ...first.context, state: changed };
  assert.throws(() => buildCapabilityExecutionInput(calibrated, { continue: true }, 'retry'), SupervisorDecisionError);
  const fresh = record(calibrated, { briefing: 'Inspect without verifying.' }, 'fresh', 'Inspection partly completed.');
  const continued = buildCapabilityExecutionInput(fresh.context, { continue: true }, 'fresh-retry');
  assert.equal(continued.briefing, 'Inspect without verifying.');
  assert.equal(continued.goal, 'Inspect without verification.');
});

test('a private child execution record cannot supply the continuation briefing', () => {
  const first = record(planned(), { briefing: originalBriefing }, 'first', 'Partial evidence.');
  const result = first.context.messages.at(-1) as ToolMessage;
  const privateResult = new ToolMessage({ ...result });
  setAgentMessageMetadata(privateResult, { lane: 'capability:general' });
  assert.throws(() => buildCapabilityExecutionInput({ ...first.context,
    messages: [...first.context.messages.slice(0, -1), privateResult] }, { continue: true }, 'retry'), SupervisorDecisionError);
});

class ScriptedModel extends BaseChatModel {
  readonly inputs: BaseMessage[][] = [];
  constructor(private readonly responses: AIMessage[]) { super({}); }
  _llmType() { return 'continuation-input-probe'; }
  bindTools() { return this; }
  async _generate(messages: BaseMessage[]) {
    const message = this.responses[this.inputs.length];
    assert.ok(message, 'unexpected extra model call');
    this.inputs.push([...messages]);
    return { generations: [{ message, text: message.text }] };
  }
}

function call(name: string, args: Record<string, unknown>, id: string) {
  return new AIMessage({ content: '', tool_calls: [{ name, args, id, type: 'tool_call' }] });
}

test('the production graph supplies fresh children with one resolved boundary and prior deliveries through three executions', async () => {
  const registry = compileAgentRegistry({ toolkits: [], capabilities: [{
    name: 'general', description: 'Inspect and verify evidence.', uses: [],
    instructions: defineInstructionDocument({ content: 'Use the available evidence to complete the delegated task.' }),
  }] });
  const firstDelivery = 'Read completed. Exact ticket: opaque-42. Verification remains.';
  const secondDelivery = 'Verification started using opaque-42. One final check remains.';
  const supervisor = new ScriptedModel([
    call('submit_plan', { tasks: [task] }, 'plan'),
    call('delegate_capability', { briefing: originalBriefing }, 'first'),
    call('review_current', { completed: false, reason: 'Verification remains.' }, 'review-first'),
    call('delegate_capability', { continue: true }, 'second'),
    call('review_current', { completed: false, reason: 'Final check remains.' }, 'review-second'),
    call('delegate_capability', { continue: true }, 'third'),
    call('review_current', { completed: true, reason: 'Verification complete.' }, 'review-third'),
    new AIMessage('Completed.'),
  ]);
  const executor = new ScriptedModel([new AIMessage(firstDelivery), new AIMessage(secondDelivery), new AIMessage('Verified: opaque-42.')]);
  const graph = createOrchestratorGraph({
    models: { act: supervisor, subagent: executor,
      answer: new ScriptedModel([call('plan_request', { goal: task.objective }, 'entry')]) },
    checkpoint: new MemorySaver(),
  });
  const result = await graph.invoke(buildOrchestratorRunInput([new HumanMessage(task.objective)]), {
    configurable: { thread_id: 'three-continuation-inputs', registry },
  });
  const executions = readCapabilityExecutions(result.messages);
  assert.equal(executions.length, 3);
  assert.equal(executor.inputs.length, 3);
  assert.equal(result.runSupervisorState.plan[0].status, 'completed');
  for (const [index, input] of executor.inputs.entries()) {
    const boundaries = input.filter(isDelegationBriefingMessage);
    assert.equal(boundaries.length, 1);
    const boundary = boundaries[0].text;
    const data = boundary.match(/<briefing>\s*<!\[CDATA\[\n([\s\S]*)\n\s*\]\]>\s*<\/briefing>/);
    assert.ok(data, 'the child must receive a complete nonempty briefing');
    assert.equal(data[1].replaceAll(']]]]><![CDATA[>', ']]>'), originalBriefing);
    assert.equal(boundary.split('<continuation source="runtime">').length - 1, index === 0 ? 0 : 1);
    assert.equal(executions[index].execution.briefing, originalBriefing);
    assert.equal(input.some(message => AIMessage.isInstance(message)
      && [firstDelivery, secondDelivery].includes(message.text)), false, 'private child output is not replayed as assistant history');
    if (index === 0) continue;
    const prior = executions[index - 1];
    assert.equal(executions[index].execution.continuation?.delegationId, prior.execution.delegationId);
    assert.ok(boundary.includes(prior.execution.delegationId));
    assert.ok(boundary.includes(prior.result.delivery!.id));
    const visibleResult = input.find(message => ToolMessage.isInstance(message)
      && message.tool_call_id === prior.call.id) as ToolMessage | undefined;
    assert.ok(visibleResult);
    assert.equal(JSON.parse(visibleResult.text).delivery.text, prior.result.delivery!.text);
  }
});
