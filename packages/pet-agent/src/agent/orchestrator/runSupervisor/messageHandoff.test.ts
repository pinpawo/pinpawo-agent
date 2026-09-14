import { createSupervisorControlValidationMiddleware } from './controlMiddleware';
import { submitPlan } from './submitPlanTool';
import { reviewCurrent } from './reviewCurrentTool';
import { adjustPlan } from './adjustPlanTool';
import { buildCapabilityExecutionInput } from './delegateCapabilityTool';
import type { SupervisorHandoffContext } from './controlContext';
import { createSubmitPlanTool } from './submitPlanTool';
import { createReviewCurrentTool } from './reviewCurrentTool';
import { createAdjustPlanTool } from './adjustPlanTool';
import { createDelegateCapabilityTool } from './delegateCapabilityTool';
import assert from 'node:assert/strict';
import test from 'node:test';
import { AIMessage, HumanMessage, ToolMessage, type BaseMessage } from '@langchain/core/messages';
import { BaseChatModel } from '@langchain/core/language_models/chat_models';
import type { ChatResult } from '@langchain/core/outputs';
import { tool, type StructuredTool } from '@langchain/core/tools';
import { z } from 'zod';
import { Annotation, Command, END, MemorySaver, START, StateGraph, interrupt, messagesStateReducer } from '@langchain/langgraph';
import { createAgent } from 'langchain';
import { getAgentMessageMetadata, setAgentMessageMetadata, queryAgentMessages } from '../../messages';
import { currentSupervisorTask, type RunSupervisorState } from './state';
import {
  acceptSupervisorMessageHandoff,
  createSupervisorMessageHandoff,
  prepareCapabilityHandoff,
} from './messageHandoff';

import { executionsForTask, readCapabilityExecutionCall } from '../executionMessages';

const taskA = { capability: 'general', task: 'Inspect A.' };
const taskB = { capability: 'general', task: 'Inspect B.' };
function control(name: string, args: Record<string, unknown>, id = 'control-1') {
  return [new AIMessage({ id: `request:${id}`, content: '', tool_calls: [{ name, args, id, type: 'tool_call' }] }),
    new ToolMessage({ content: 'submitted', name, tool_call_id: id })];
}
function context(overrides: Partial<SupervisorHandoffContext> = {}): SupervisorHandoffContext {
  return { state: { goal: null, plan: [] }, runId: 'r1', traceId: 't1', userRequest: 'Inspect the project.',
    mode: 'entry', hasNewUserInput: true, allowedCapabilityNames: ['general'], messages: [], ...overrides };
}
function resultFor(dispatch: AIMessage) {
  const { execution } = readCapabilityExecutionCall(dispatch)!;
  const metadata = getAgentMessageMetadata(dispatch);
  return setAgentMessageMetadata(new ToolMessage({ id: `result:${dispatch.id}`, name: 'delegate_capability',
    tool_call_id: dispatch.tool_calls![0].id!,
    content: JSON.stringify({ status: 'returned', delivery: { id: `delivery:${dispatch.id}`, task: execution.task, text: 'Verified execution evidence.', scope: {
      runId: metadata.runId, traceId: metadata.traceId, delegationId: execution.delegationId,
      lane: `capability:${execution.capability}`,
    } }, artifacts: [] }),
  }), metadata);
}
function dispatchResult(input: SupervisorHandoffContext, callId = 'execute-first', feedback?: string) {
  const decision = buildCapabilityExecutionInput(input, feedback);
  const pair = control('delegate_capability', {}, callId);
  const request = prepareCapabilityHandoff(input, pair[0] as AIMessage, decision);
  return { runSupervisorState: input.state, messages: createSupervisorMessageHandoff(input, [request]) };
}
function returned(firstContext = context(), tasks = [taskA, taskB]) {
  const state = submitPlan(firstContext, { tasks }, 'plan');
  const result = dispatchResult({ ...firstContext, state });
  const accepted = acceptSupervisorMessageHandoff(firstContext, result);
  const dispatch = result.messages.at(-1) as AIMessage;
  return { ...firstContext, state: accepted.runSupervisorState,
    messages: [...firstContext.messages, ...result.messages, resultFor(dispatch)], mode: 'boundary' as const };
}

test('handoff commits explicit state without replaying historical control arguments', () => {
  const input = context();
  const state = submitPlan(input, { tasks: [taskA, taskB] }, 'plan');
  // Transcript content deliberately disagrees: only the tool-maintained state is authoritative.
  const stale = control('submit_plan', { tasks: [taskB] }, 'old-plan');
  const decision = buildCapabilityExecutionInput({ ...input, state });
  const pair = control('delegate_capability', {}, 'execute-first');
  const request = prepareCapabilityHandoff(input, pair[0] as AIMessage, decision);
  const internal = [...stale, request];
  const original = JSON.stringify(internal);
  const messages = createSupervisorMessageHandoff(input, internal);
  const accepted = acceptSupervisorMessageHandoff(input, { messages, runSupervisorState: state });
  assert.deepEqual(accepted.runSupervisorState, state);
  assert.equal(JSON.stringify(internal), original);
  const dispatch = messages.at(-1) as AIMessage;
  const execution = readCapabilityExecutionCall(dispatch)!;
  assert.deepEqual(execution.call.args, {});
  assert.equal(execution.metadata.sourceToolCallId, 'execute-first');
  assert.deepEqual(JSON.parse(execution.execution.briefing), {
    plan: [taskA, taskB].map(task => ({ ...task, status: 'pending' })),
  });
  assert.equal(messages.length, 3);
  const main = queryAgentMessages([...messages, resultFor(dispatch)]).main().select().messages;
  assert.equal(main.length, 2);
  assert.equal((main[1] as ToolMessage).tool_call_id, execution.call.id);
});

test('handoff prepares execution inputs without producing a local result', () => {
  const input = returned();
  const request = control('delegate_capability', {}, 'next')[0] as AIMessage;
  const before = JSON.stringify(request);
  const prepared = prepareCapabilityHandoff(input, request, buildCapabilityExecutionInput(input));
  assert.equal(JSON.stringify(request), before);
  assert.equal(prepared.id, request.id, 'Command updates the same AI message');
  assert.deepEqual(prepared.tool_calls, request.tool_calls);
  assert.equal(readCapabilityExecutionCall(prepared)!.execution.task, taskA.task);
  assert.equal('artifact' in prepared, false);
  assert.throws(() => prepareCapabilityHandoff(input, new AIMessage('No tool call'), buildCapabilityExecutionInput(input)), /exclusive/);
  const raw = createSupervisorMessageHandoff(input, [request]);
  assert.equal(queryAgentMessages(raw).main().select().messages.length, 0, 'unprepared model request is not a handoff');
});

test('Root rejects mismatched execution identity, task, capability, arguments and duplicate handoff', () => {
  const input = returned();
  const result = dispatchResult(input, 'retry');
  for (const mutate of [
    (m: AIMessage) => { (getAgentMessageMetadata(m).execution as { task: string }).task = 'Different task'; },
    (m: AIMessage) => { (getAgentMessageMetadata(m).execution as { capability: string }).capability = 'unavailable'; },
    (m: AIMessage) => { getAgentMessageMetadata(m).runId = 'different-run'; },
    (m: AIMessage) => { m.id = 'different-message'; },
    (m: AIMessage) => { m.tool_calls![0].args = { taskId: 'injected' }; },
  ]) {
    const dispatch = new AIMessage({ ...result.messages.at(-1) as AIMessage });
    dispatch.tool_calls = structuredClone(dispatch.tool_calls);
    dispatch.additional_kwargs = structuredClone(dispatch.additional_kwargs);
    mutate(dispatch);
    assert.throws(() => acceptSupervisorMessageHandoff(input, { ...result, messages: [dispatch] }));
  }
  assert.throws(() => acceptSupervisorMessageHandoff({ ...input, messages: [...input.messages, ...result.messages] }, result), /already accepted/);
  const replay = new AIMessage({ ...result.messages.at(-1) as AIMessage, id: 'different-message' });
  assert.throws(() => acceptSupervisorMessageHandoff({ ...input, messages: result.messages }, { ...result, messages: [replay] }), /already accepted/);
});

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
      content: JSON.stringify({ status, delivery: null, artifacts: [] }),
    }), getAgentMessageMetadata(dispatch));
    const input = { ...first, messages: [...first.messages, ...retry.messages, failure] };
    assert.throws(() => reviewCurrent(input, { completed: true, reason: 'Old evidence' }), /returned delivery/);
    assert.ok(buildCapabilityExecutionInput(input));
  }
});

test('same-run retries retain execution scope; new runs start a new delegation', () => {
  const input = returned();
  const before = readCapabilityExecutionCall(input.messages[0])!.execution;
  const retry = buildCapabilityExecutionInput(input, 'Missing evidence');
  const fresh = buildCapabilityExecutionInput({ ...input, runId: 'r2' }, 'Missing evidence');
  assert.equal(retry.mode, 'continue');
  assert.equal(retry.delegationId, before.delegationId);
  assert.equal(fresh.mode, 'initial');
  assert.notEqual(fresh.delegationId, before.delegationId);
  assert.equal(fresh.briefing, retry.briefing);
  assert.equal(JSON.parse(retry.briefing).feedback, 'Missing evidence');
  assert.throws(() => buildCapabilityExecutionInput({ ...input, messages: input.messages.slice(0, -1) }), /no result/);
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

class OneControlModel extends BaseChatModel {
  invocations = 0;
  _llmType() { return 'single-control'; }
  bindTools() { return this; }
  async _generate(): Promise<ChatResult> {
    if (++this.invocations > 2) throw new Error('Unexpected extra model dispatch');
    const message = (this.invocations === 1 ? control('submit_plan', { tasks: [taskA] }) : control('delegate_capability', {}, 'execute-first'))[0] as AIMessage;
    return { generations: [{ message, text: '' }] };
  }
}

test('unavailable tools return framework feedback and allow correction without mutating Root', async () => {
  for (const name of ['unknown_tool', 'capability_details']) {
    const input = context({ mode: 'boundary', hasNewUserInput: false });
    const before = JSON.stringify(input);
    const model = new DecisionLoopModel([
      () => new AIMessage({ content: '', tool_calls: [{ name, args: {}, id: 'unknown' }] }),
      (messages) => {
        const feedback = messages.at(-1);
        assert.ok(ToolMessage.isInstance(feedback));
        assert.equal(feedback.status, 'error');
        assert.equal(feedback.tool_call_id, 'unknown');
        assert.equal(feedback.name, name);
        assert.match(feedback.text, /submit_plan/);
        assert.equal(JSON.stringify(input), before);
        return control('submit_plan', { tasks: [taskA] })[0] as AIMessage;
      },
      () => control('delegate_capability', {}, 'execute-first')[0] as AIMessage,
    ]);
    const accepted = await decisionLoop(input, model);
    assert.equal(model.inputs.length, 3);
    assert.equal(accepted.runSupervisorState.plan.length, 1);
    assert.equal(JSON.stringify(input), before);
  }
});

test('invalid business decisions return feedback without mutating Root', async () => {
  const input = context({ allowedCapabilityNames: [] });
  const before = JSON.stringify(input);
  const model = new DecisionLoopModel([
    () => control('submit_plan', { tasks: [taskA] })[0] as AIMessage,
    (messages) => {
      const feedback = messages.at(-1) as ToolMessage;
      assert.equal(feedback.status, 'error');
      assert.match(feedback.text, /outside the current catalog/);
      return new AIMessage('No capability is available.');
    },
  ]);
  const agent = createAgent({ model, tools: toolsFor(input),
    middleware: [createSupervisorControlValidationMiddleware()] });
  const result = await agent.invoke({ messages: [new HumanMessage('Inspect A.')], runSupervisorState: input.state });
  assert.equal(result.messages.at(-1)?.text, 'No capability is available.');
  assert.equal(model.inputs.length, 2);
  assert.equal(JSON.stringify(input), before);
});

test('repeated malformed arguments stop at the graph recursion limit without dispatch', async () => {
  const input = context();
  class InvalidModel extends OneControlModel {
    async _generate(): Promise<ChatResult> {
      const message = new AIMessage({ content: '', invalid_tool_calls: [{
        name: 'delegate_capability', id: `bad-${++this.invocations}`, args: '{', type: 'invalid_tool_call',
      }] });
      return { generations: [{ message, text: '' }] };
    }
  }
  const model = new InvalidModel({});
  const agent = createAgent({ model, tools: toolsFor(input),
    middleware: [createSupervisorControlValidationMiddleware()] });
  await assert.rejects(agent.invoke({ messages: [new HumanMessage('Inspect A.')], runSupervisorState: input.state }, { recursionLimit: 6 }),
    /Recursion limit/i);
  assert.ok(model.invocations > 1 && model.invocations <= 6);
  assert.deepEqual(input.state.plan, []);
});

test('mixed model control and discovery calls are rejected before either tool executes', async () => {
  const input = context();
  let queries = 0;
  class MixedModel extends OneControlModel {
    async _generate(): Promise<ChatResult> {
      const message = new AIMessage({ content: '', tool_calls: [
        { name: 'submit_plan', id: 'control-1', args: { tasks: [taskA] } },
        { name: 'capability_details', id: 'query', args: {} },
      ] });
      return { generations: [{ message, text: '' }] };
    }
  }
  const query: StructuredTool = tool(() => { queries += 1; return 'details'; }, {
    name: 'capability_details', description: 'Read details', schema: z.object({}),
  });
  const model: BaseChatModel = new MixedModel({});
  const tools: StructuredTool[] = [...toolsFor(input), query];
  const agent = createAgent({ model, tools,
    middleware: [createSupervisorControlValidationMiddleware()] });
  await assert.rejects(agent.invoke({ messages: [new HumanMessage('Inspect A.')], runSupervisorState: input.state }), /only tool call/);
  assert.equal(queries, 0);
});

test('real createAgent continues after planning and exits only on explicit execution and Root resumes its execution call from checkpoint', async () => {
  const model = new OneControlModel({});
  const saver = new MemorySaver();
  const rootState = Annotation.Root({
    messages: Annotation<BaseMessage[]>({ reducer: messagesStateReducer, default: () => [] }),
    runSupervisorState: Annotation<RunSupervisorState>({ reducer: (_previous, next) => next,
      default: () => ({ goal: null, plan: [] }) }),
  });
  let executed = 0;
  function graph() {
    return new StateGraph(rootState)
      .addNode('supervisor', async (state) => {
        const input = context({ state: state.runSupervisorState, messages: state.messages });
        const agent = createAgent({ model, tools: toolsFor(input),
          middleware: [createSupervisorControlValidationMiddleware()] });
        const result = await agent.invoke({ messages: [new HumanMessage('Inspect A.')], runSupervisorState: input.state });
        assert.equal(result.messages.length, 4);
        assert.deepEqual(Object.keys(result).sort(), ['messages', 'reviewFeedback', 'runSupervisorState']);
        const accepted = acceptSupervisorMessageHandoff(input, { runSupervisorState: result.runSupervisorState, messages: createSupervisorMessageHandoff(input, result.messages.slice(1)) });
        return { messages: accepted.messages, runSupervisorState: accepted.runSupervisorState };
      })
      .addNode('capability', (state) => {
        const dispatch = state.messages.at(-1) as AIMessage;
        interrupt('Approve this execution');
        executed += 1;
        return { messages: [resultFor(dispatch)] };
      })
      .addEdge(START, 'supervisor').addEdge('supervisor', 'capability').addEdge('capability', END)
      .compile({ checkpointer: saver });
  }
  const options = { configurable: { thread_id: 'message-handoff' } };
  await graph().invoke({ messages: [] }, options);
  const checkpoint = await graph().getState(options);
  assert.equal(executed, 0);
  assert.equal(model.invocations, 2);
  const callId = (checkpoint.values.messages.at(-1) as AIMessage).tool_calls![0].id;
  const resumed = await graph().invoke(new Command({ resume: true }), options);
  assert.equal(executed, 1);
  assert.equal(model.invocations, 2);
  assert.equal((resumed.messages.at(-1) as ToolMessage).tool_call_id, callId);
  assert.equal(currentSupervisorTask(resumed.runSupervisorState)?.status, 'pending');
});


/** Each entry is one actual model turn; no automatic continuation in this fixture. */
class DecisionLoopModel extends BaseChatModel {
  inputs: BaseMessage[][] = [];
  constructor(private readonly turns: Array<(messages: BaseMessage[]) => AIMessage>) { super({}); }
  _llmType() { return 'explicit-supervisor-loop'; }
  bindTools() { return this; }
  async _generate(messages: BaseMessage[]): Promise<ChatResult> {
    const turn = this.turns[this.inputs.length];
    assert.ok(turn, 'Unexpected model turn');
    this.inputs.push([...messages]);
    const message = turn(messages);
    return { generations: [{ message, text: message.text }] };
  }
}
function toolPlan(messages: BaseMessage[]) {
  const result = messages.at(-1);
  assert.ok(ToolMessage.isInstance(result));
  return JSON.parse(result.text) as { plan: RunSupervisorState; execution: unknown };
}
async function decisionLoop(input: SupervisorHandoffContext, model: DecisionLoopModel) {
  const agent = createAgent({ model, tools: toolsFor(input),
    middleware: [createSupervisorControlValidationMiddleware()] });
  const result = await agent.invoke({ messages: [new HumanMessage('Decide the next step.')], runSupervisorState: input.state });
  return acceptSupervisorMessageHandoff(input, { runSupervisorState: result.runSupervisorState, messages: createSupervisorMessageHandoff(input, result.messages.slice(1)) });
}

test('review of the last task returns completed facts to the model, which replies naturally', async () => {
  const input = returned(context(), [taskA]);
  const before = JSON.stringify(input.state);
  const model = new DecisionLoopModel([
    () => control('review_current', { completed: true, reason: 'Delivery verified.' }, 'review-final')[0] as AIMessage,
    (messages) => {
      const facts = toolPlan(messages);
      assert.equal(facts.plan.plan[0].status, 'completed');
      assert.equal('execution' in facts, false);
      assert.equal(JSON.stringify(input.state), before, 'Root has not committed yet');
      return new AIMessage('Inspection complete.');
    },
  ]);
  const accepted = await decisionLoop(input, model);
  assert.equal(model.inputs.length, 2);
  assert.equal(accepted.reply, 'Inspection complete.');
  assert.equal(accepted.runSupervisorState.plan[0].status, 'completed');
  assert.equal(queryAgentMessages(accepted.messages).main().select().messages.length, 0);
});

test('review, autonomous adjustment and explicit execution share updated facts in one model loop', async () => {
  const input = { ...returned(), hasNewUserInput: false };
  const model = new DecisionLoopModel([
    () => control('review_current', { completed: true, reason: 'A is verified.' }, 'review-A')[0] as AIMessage,
    (messages) => {
      assert.deepEqual(toolPlan(messages).plan.plan.map((task) => task.status), ['completed', 'pending']);
      return control('adjust_plan', { goal: input.state.goal, reason: 'Use the evidence from A.',
        currentDelegation: 'replace', tasks: [{ ...taskB, task: 'Inspect B using A evidence.' }] }, 'adjust-B')[0] as AIMessage;
    },
    (messages) => {
      const facts = toolPlan(messages);
      assert.equal('execution' in facts, false);
      assert.equal(currentSupervisorTask(facts.plan)?.task, 'Inspect B using A evidence.');
      return control('delegate_capability', {}, 'execute-B')[0] as AIMessage;
    },
  ]);
  const accepted = await decisionLoop(input, model);
  assert.equal(model.inputs.length, 3);
  assert.equal(accepted.reply, null);
  const dispatch = accepted.messages.at(-1) as AIMessage;
  const { execution } = readCapabilityExecutionCall(dispatch)!;
  assert.equal(execution.task, 'Inspect B using A evidence.');
  assert.equal(JSON.parse(execution.briefing).plan.at(-1).task, 'Inspect B using A evidence.');
  assert.deepEqual(accepted.runSupervisorState.plan.map((task) => task.status), ['completed', 'pending']);
  assert.equal(queryAgentMessages(accepted.messages).main().select().messages.length, 1);
});

test('planning and adjustment can end with a question without dispatching pending work', async () => {
  const input = context();
  const model = new DecisionLoopModel([
    () => control('submit_plan', { tasks: [taskA] }, 'plan')[0] as AIMessage,
    (messages) => {
      assert.equal(toolPlan(messages).plan.plan.length, 1);
      return control('adjust_plan', { goal: input.userRequest, reason: 'The destination must be chosen first.',
        currentDelegation: 'continue', tasks: [{ ...taskA, task: 'Inspect the selected destination.' }] }, 'adjust')[0] as AIMessage;
    },
    (messages) => {
      assert.equal(currentSupervisorTask(toolPlan(messages).plan)?.task, 'Inspect the selected destination.');
      return new AIMessage('Which destination should I inspect?');
    },
  ]);
  const accepted = await decisionLoop(input, model);
  assert.equal(model.inputs.length, 3);
  assert.equal(accepted.reply, 'Which destination should I inspect?');
  assert.equal(accepted.runSupervisorState.plan[0].status, 'pending');
  assert.equal(queryAgentMessages(accepted.messages).main().select().messages.length, 0);
});


test('control message identities are run scoped even when the provider reuses message and call ids', () => {
  const pair = control('submit_plan', { tasks: [taskA] }, 'reused-call');
  pair[0].id = 'provider-request'; pair[1].id = 'provider-result';
  const first = createSupervisorMessageHandoff(context(), pair);
  const second = createSupervisorMessageHandoff(context({ runId: 'r2' }), pair);
  assert.notEqual(first[0].id, second[0].id);
  assert.notEqual(first[1].id, second[1].id);
  assert.deepEqual(createSupervisorMessageHandoff(context(), pair).map((message) => message.id), first.map((message) => message.id));
});


test('tool cancellation propagates without model correction', async () => {
  const model = new DecisionLoopModel([
    () => new AIMessage({ content: '', tool_calls: [{ name: 'capability_details', args: {}, id: 'read' }] }),
  ]);
  const reader = tool(() => { throw new DOMException('Read cancelled', 'AbortError'); }, {
    name: 'capability_details', description: 'Read details', schema: z.object({}),
  });
  const agent = createAgent({ model, tools: [reader], middleware: [createSupervisorControlValidationMiddleware()] });
  await assert.rejects(agent.invoke({ messages: [new HumanMessage('Read details.')], runSupervisorState: context().state }), /Read cancelled/);
  assert.equal(model.inputs.length, 1);
});

test('tool interrupt remains resumable rather than becoming correction feedback', async () => {
  const model = new DecisionLoopModel([
    () => new AIMessage({ content: '', tool_calls: [{ name: 'capability_details', args: {}, id: 'read' }] }),
    (messages) => {
      const receipt = messages.at(-1);
      assert.ok(ToolMessage.isInstance(receipt));
      assert.notEqual(receipt.status, 'error');
      assert.equal(receipt.text, 'Approved details');
      return new AIMessage('Read complete.');
    },
  ]);
  const reader = tool(() => interrupt('Approve details'), {
    name: 'capability_details', description: 'Read details', schema: z.object({}),
  });
  const agent = createAgent({ model, tools: [reader], checkpointer: new MemorySaver(),
    middleware: [createSupervisorControlValidationMiddleware()] });
  const config = { configurable: { thread_id: 'tool-interrupt-recovery' } };
  const paused = await agent.invoke({ messages: [new HumanMessage('Read details.')], runSupervisorState: context().state }, config);
  assert.equal(paused.__interrupt__?.length, 1);
  assert.equal(model.inputs.length, 1);
  const resumed = await agent.invoke(new Command({ resume: 'Approved details' }), config);
  assert.equal(resumed.messages.at(-1)?.text, 'Read complete.');
  assert.equal(model.inputs.length, 2);
});

test('later plan edits cannot rewrite an existing execution snapshot', () => {
  const input = returned();
  const dispatch = input.messages[0] as AIMessage;
  const before = readCapabilityExecutionCall(dispatch)!.execution;
  const revised = adjustPlan(input, { goal: input.userRequest, reason: 'Follow up', currentDelegation: 'continue',
    tasks: [{ ...taskA, task: 'Only follow-up work.' }] }, 'adjust');
  assert.equal(revised.plan[0].task, 'Only follow-up work.');
  assert.equal(readCapabilityExecutionCall(dispatch)!.execution.briefing, before.briefing);
  assert.equal(readCapabilityExecutionCall(dispatch)!.execution.task, taskA.task);
});

/** Test fixture registration; tool implementations remain independent. */
function toolsFor(context: SupervisorHandoffContext) {
  return [createSubmitPlanTool(context), createReviewCurrentTool(context), createAdjustPlanTool(context), createDelegateCapabilityTool(context)];
}

test('tools read initialized state even when history contains a different successful plan', async () => {
  const input = context({ state: { goal: 'Inspect B', plan: [{ ...taskB, id: 'B', status: 'pending' }] } });
  const model = new DecisionLoopModel([() => control('delegate_capability', {}, 'execute-B')[0] as AIMessage]);
  const agent = createAgent({ model, tools: toolsFor(input), middleware: [createSupervisorControlValidationMiddleware()] });
  const history = control('submit_plan', { tasks: [taskA] }, 'old-plan');
  const result = await agent.invoke({ messages: [...history, new HumanMessage('Continue B')], runSupervisorState: input.state });
  const handoff = createSupervisorMessageHandoff(input, result.messages.slice(3));
  assert.equal(readCapabilityExecutionCall(handoff.at(-1)!)!.execution.taskId, 'B');
  assert.deepEqual(result.runSupervisorState, input.state);
  assert.equal(model.inputs.length, 1);
});

test('review feedback lives in state and is cleared only by successful planning or acceptance', async () => {
  for (const next of ['delegate', 'invalid-adjust', 'adjust', 'accept'] as const) {
    const input = returned();
    const feedback = 'The returned result misses the requested evidence.';
    const turns: Array<(messages: BaseMessage[]) => AIMessage> = [
      () => control('review_current', { completed: false, reason: feedback }, 'reject')[0] as AIMessage,
    ];
    if (next === 'adjust' || next === 'invalid-adjust') turns.push(() => control('adjust_plan', {
      goal: input.userRequest, reason: 'Narrow the follow-up', currentDelegation: 'continue',
      tasks: [{ capability: next === 'adjust' ? 'general' : 'unavailable', task: 'Verify missing evidence.' }],
    }, 'adjust')[0] as AIMessage);
    if (next === 'accept') turns.push(() => control('review_current', { completed: true, reason: 'The existing delivery is sufficient.' }, 'accept')[0] as AIMessage);
    turns.push(() => control('delegate_capability', {}, 'execute')[0] as AIMessage);
    const accepted = await decisionLoop(input, new DecisionLoopModel(turns));
    const execution = readCapabilityExecutionCall(accepted.messages.at(-1)!)!.execution;
    assert.equal(JSON.parse(execution.briefing).feedback, next === 'delegate' || next === 'invalid-adjust' ? feedback : undefined);
    assert.equal(execution.task, next === 'accept' ? taskB.task : next === 'adjust' ? 'Verify missing evidence.' : taskA.task);
  }
});
