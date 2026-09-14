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
  createSupervisorControlValidationMiddleware,
  createSupervisorMessageHandoff,
  type SupervisorHandoffContext,
} from './messageHandoff';

import { executionsForTask, readCapabilityExecutionCall } from '../executionMessages';

const taskA = { capability: 'general', task: 'Inspect A.' };
const taskB = { capability: 'general', task: 'Inspect B.' };
function control(name: string, args: Record<string, unknown>, id = 'control-1') {
  return [new AIMessage({ content: '', tool_calls: [{ name, args, id, type: 'tool_call' }] }),
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
function returned(firstContext = context(), tasks = [taskA, taskB]) {
  const handoff = createSupervisorMessageHandoff(firstContext, [...control('submit_plan', { tasks }), ...control('delegate_capability', {}, 'execute-first')] );
  const accepted = acceptSupervisorMessageHandoff(firstContext, handoff);
  const dispatch = handoff.at(-1) as AIMessage;
  return {
    ...firstContext, state: accepted.runSupervisorState,
    messages: [...firstContext.messages, ...handoff, resultFor(dispatch)], mode: 'boundary' as const,
  };
}

test('Supervisor delegates once; Root supplies the actual result without a second call', () => {
  const input = context();
  const internal = [...control('submit_plan', { tasks: [taskA, taskB] }), ...control('delegate_capability', {}, 'execute-first')];
  const original = JSON.stringify(internal);
  const handoff = createSupervisorMessageHandoff(input, internal);
  const accepted = acceptSupervisorMessageHandoff(input, handoff);
  assert.deepEqual(Object.keys(accepted.runSupervisorState).sort(), ['goal', 'plan']);
  assert.equal(accepted.runSupervisorState.plan.length, 2);
  assert.equal(accepted.runSupervisorState.plan[0].status, 'pending');
  assert.equal(accepted.runSupervisorState.plan[1].status, 'pending');
  assert.equal(JSON.stringify(internal), original, 'the model transcript must not be rewritten');
  const dispatch = handoff.at(-1) as AIMessage;
  assert.notEqual(dispatch.tool_calls![0].id, 'control-1');
  assert.equal(getAgentMessageMetadata(dispatch).sourceToolCallId, 'execute-first');
  assert.deepEqual(JSON.parse(readCapabilityExecutionCall(dispatch)!.execution.briefing), {
    task: taskA.task, plan: [taskA, taskB].map(task => ({ ...task, status: 'pending' })),
  });
  assert.equal(getAgentMessageMetadata(dispatch).source, 'supervisor');
  assert.equal(handoff.length, 3);
  const main = queryAgentMessages([...handoff, resultFor(dispatch)]).main().select().messages;
  assert.equal(main.length, 2);
  assert.equal((main[1] as ToolMessage).tool_call_id, dispatch.tool_calls![0].id);
  assert.equal(queryAgentMessages(handoff).supervisor('r1').select().messages.length, 2);
});

test('accepted A may end the run with a question, then Boundary starts B without active delegation', () => {
  const first = returned();
  const accepted = acceptSupervisorMessageHandoff(first, createSupervisorMessageHandoff(first,
    [...control('review_current', { completed: true, reason: 'Evidence verified.' }, 'review-A'), new AIMessage('Shall I inspect B?')]));
  assert.equal(accepted.messages.length, 3, 'no execution call when replying');
  assert.equal(accepted.runSupervisorState.plan[0].status, 'completed');
  const next = context({ ...first, runId: 'r2', state: accepted.runSupervisorState,
    messages: [...first.messages, ...accepted.messages, new HumanMessage('Yes, proceed.')],
  });
  const handoff = createSupervisorMessageHandoff(next,
    control('delegate_capability', {}, 'start-B'));
  const execution = readCapabilityExecutionCall(handoff.at(-1) as AIMessage)!.execution;
  assert.equal(execution.task, taskB.task);
  assert.equal(execution.mode, 'initial');
  assert.equal(acceptSupervisorMessageHandoff(next, handoff).runSupervisorState.plan[0].status, 'completed');
});

test('a review question can defer acceptance without dispatching or changing returned progress', () => {
  const input = returned();
  const handoff = createSupervisorMessageHandoff(input, [new AIMessage('Which destination?')]);
  const accepted = acceptSupervisorMessageHandoff(input, handoff);
  assert.deepEqual(accepted.runSupervisorState, input.state);
  assert.equal(accepted.reply, 'Which destination?');
  assert.equal(accepted.messages.length, 1);
  assert.equal(queryAgentMessages(handoff).main().select().messages.length, 0);
});

test('a failed retry cannot be accepted using an older successful delivery', () => {
  const first = returned();
  const retry = createSupervisorMessageHandoff(first,
    [...control('review_current', { completed: false, reason: 'Verify missing evidence.' }, 'retry-failed'), ...control('delegate_capability', {}, 'execute-retry')]);
  const dispatch = retry.at(-1) as AIMessage;
  for (const status of ['missing_deliverable', 'paused']) {
    const result = setAgentMessageMetadata(new ToolMessage({ name: 'delegate_capability',
      tool_call_id: dispatch.tool_calls![0].id!, status: status === 'missing_deliverable' ? 'error' : 'success',
      content: JSON.stringify({ status, delivery: null, artifacts: [] }),
    }), getAgentMessageMetadata(dispatch));
    const input = { ...first, messages: [...first.messages, ...retry, result] };
    assert.equal(executionsForTask(input, first.state.plan[0].id).at(-1)?.result?.status, status);
    assert.throws(() => createSupervisorMessageHandoff(input,
      control('review_current', { completed: true, reason: 'Old evidence is enough.' }, 'accept-failed')), /returned delivery/);
    assert.equal(createSupervisorMessageHandoff(input,
      control('delegate_capability', {}, 'retry-again')).length, 1);
  }
});

test('acceptance ignores private, mismatched, malformed and error results', () => {
  const first = returned();
  const original = first.messages.at(-1) as ToolMessage;
  for (const mutation of [
    (message: ToolMessage) => setAgentMessageMetadata(message, { lane: 'capability:general' }),
    (message: ToolMessage) => setAgentMessageMetadata(message, { runId: 'other-run' }),
    (message: ToolMessage) => { message.tool_call_id = 'other-call'; },
    (message: ToolMessage) => { message.status = 'error'; },
    (message: ToolMessage) => { message.content = '{invalid'; },
    (message: ToolMessage) => {
      const result = JSON.parse(message.text);
      result.delivery.scope.delegationId = 'other-delegation';
      message.content = JSON.stringify(result);
    },
  ]) {
    const message = new ToolMessage({ ...original });
    mutation(message);
    const input = { ...first, messages: [...first.messages.slice(0, -1), message] };
    assert.throws(() => createSupervisorMessageHandoff(input,
      control('review_current', { completed: true, reason: 'Verify result.' }, 'bad-evidence')), /returned delivery/);
  }
});

test('same-run retries keep execution scope; new runs never inherit the old delegation instance', () => {
  const first = returned();
  const retry = [...control('review_current', { completed: false, reason: 'Check the missing detail.' }, 'retry'), ...control('delegate_capability', {}, 'execute-retry')];
  const oldDispatch = first.messages.find((message) => AIMessage.isInstance(message)
    && message.tool_calls?.[0]?.name === 'delegate_capability') as AIMessage;
  const oldExecution = readCapabilityExecutionCall(oldDispatch)!.execution;
  const same = createSupervisorMessageHandoff(first, retry).at(-1) as AIMessage;
  const sameExecution = readCapabilityExecutionCall(same)!.execution;
  assert.equal(sameExecution.delegationId, oldExecution.delegationId);
  assert.equal(sameExecution.mode, 'continue');
  assert.equal(JSON.parse(sameExecution.briefing).feedback, 'Check the missing detail.');
  const fresh = createSupervisorMessageHandoff({ ...first, runId: 'r2' }, retry).at(-1) as AIMessage;
  const freshExecution = readCapabilityExecutionCall(fresh)!.execution;
  assert.notEqual(freshExecution.delegationId, oldExecution.delegationId);
  assert.equal(freshExecution.mode, 'initial');
  assert.equal(freshExecution.briefing, sameExecution.briefing);
  assert.notEqual(fresh.tool_calls![0].id, same.tool_calls![0].id);
  assert.equal(queryAgentMessages(first.messages).supervisor('r2').select().messages.length, 0);
});

test('handoff rejects unexecuted, mixed, mismatched, unavailable and replayed calls', () => {
  const input = context();
  const pair = control('submit_plan', { tasks: [taskA] });
  assert.throws(() => createSupervisorMessageHandoff(input, pair.slice(0, 1)), /completed exclusive/);
  for (const confirmation of [
    { name: 'submit_plan', tool_call_id: 'wrong' },
    { name: 'capability_details', tool_call_id: 'control-1' },
  ]) assert.throws(() => createSupervisorMessageHandoff(input, [pair[0], new ToolMessage({
    content: 'submitted', ...confirmation,
  })]), /does not match/);
  assert.deepEqual(acceptSupervisorMessageHandoff(input, createSupervisorMessageHandoff(input, [pair[0], new ToolMessage({
    content: 'tool execution failed', status: 'error', name: 'submit_plan', tool_call_id: 'control-1',
  })])).runSupervisorState, input.state);
  const mixed = new AIMessage({ content: '', tool_calls: [
    { name: 'submit_plan', args: { tasks: [taskA] }, id: 'control-1' },
    { name: 'capability_details', args: { names: ['general'] }, id: 'details' },
  ] });
  assert.throws(() => createSupervisorMessageHandoff(input, [mixed, pair[1]]), /exclusive/);
  assert.throws(() => createSupervisorMessageHandoff({ ...input, allowedCapabilityNames: [] }, pair), /catalog/);
  const handoff = createSupervisorMessageHandoff(input, [...pair, ...control('delegate_capability', {}, 'execute')]);
  assert.equal(acceptSupervisorMessageHandoff(input, handoff.slice(0, -1)).messages.length, 2, 'plan alone never dispatches');
  const altered = new AIMessage({ ...(handoff.at(-1) as AIMessage) });
  altered.tool_calls = structuredClone(altered.tool_calls);
  altered.additional_kwargs = structuredClone(altered.additional_kwargs);
  (getAgentMessageMetadata(altered).execution as { task: string }).task = 'Different work';
  assert.throws(() => acceptSupervisorMessageHandoff(input, [...handoff.slice(0, -1), altered]), /does not match/);
  assert.throws(() => acceptSupervisorMessageHandoff({ ...input, messages: handoff }, handoff), /already accepted/);
  assert.throws(() => createSupervisorMessageHandoff({ ...returned(), messages: [] },
    control('review_current', { completed: true, reason: 'Unsubstantiated claim.' })), /delivery/);
});

test('plan adjustment preserves completed work and requires fresh input only for a changed goal', () => {
  const input = returned();
  const completed = acceptSupervisorMessageHandoff(input, createSupervisorMessageHandoff(input,
    [...control('review_current', { completed: true, reason: 'Verified.' }, 'accept'), new AIMessage('Awaiting choice.')]));
  const next = { ...input, state: completed.runSupervisorState };
  const pair = control('adjust_plan', { goal: 'New agreed goal', reason: 'User changed B.',
    currentDelegation: 'replace', tasks: [{ ...taskB, task: 'Inspect revised B.' }],
  }, 'adjust');
  assert.throws(() => createSupervisorMessageHandoff({ ...next, hasNewUserInput: false }, pair), /fresh user/);
  const revised = acceptSupervisorMessageHandoff(next, createSupervisorMessageHandoff(next, pair));
  assert.equal(revised.runSupervisorState.goal, 'New agreed goal');
  assert.equal(revised.runSupervisorState.plan[0].status, 'completed');
  assert.equal(currentSupervisorTask(revised.runSupervisorState)?.task, 'Inspect revised B.');
});

test('execution-driven adjustment preserves the goal and completed work at both handoff boundaries', () => {
  const input = returned();
  const completed = acceptSupervisorMessageHandoff(input, createSupervisorMessageHandoff(input,
    [...control('review_current', { completed: true, reason: 'Verified.' }, 'accept'), new AIMessage('Paused.')]));
  const next = { ...input, state: completed.runSupervisorState, hasNewUserInput: false };
  for (const currentDelegation of ['continue', 'replace']) {
    const pair = control('adjust_plan', { goal: next.state.goal, reason: 'Evidence requires a different inspection order.',
      currentDelegation, tasks: [{ ...taskB, task: 'Inspect B using the evidence from A.' }],
    }, `autonomous-${currentDelegation}`);
    const handoff = createSupervisorMessageHandoff(next, pair);
    const revised = acceptSupervisorMessageHandoff(next, handoff);
    assert.equal(revised.runSupervisorState.goal, next.state.goal);
    assert.equal(revised.runSupervisorState.plan[0].status, 'completed');
    assert.equal(currentSupervisorTask(revised.runSupervisorState)?.task, 'Inspect B using the evidence from A.');
    assert.throws(() => acceptSupervisorMessageHandoff({ ...next, state: { ...next.state, goal: 'Another goal' } }, handoff), /fresh user/);
  }
});

test('replacing executed but unaccepted work preserves it as superseded, not pending', () => {
  const input = returned();
  const handoff = createSupervisorMessageHandoff(input, control('adjust_plan', {
    goal: 'Changed goal', reason: 'User replaced the work.', currentDelegation: 'replace', tasks: [taskB],
  }, 'replace-executed'));
  const accepted = acceptSupervisorMessageHandoff(input, handoff);
  assert.equal(queryAgentMessages(handoff).main().select().messages.length, 0);
  assert.deepEqual(accepted.runSupervisorState.plan.map(({ status }) => status), ['superseded', 'pending']);
  assert.equal(accepted.runSupervisorState.plan[0].id, input.state.plan[0].id);
  assert.notEqual(accepted.runSupervisorState.plan[1].id, input.state.plan[1].id);
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
  const agent = createAgent({ model, tools: [createSubmitPlanTool(input), createReviewCurrentTool(input), createAdjustPlanTool(input), createDelegateCapabilityTool(input)],
    middleware: [createSupervisorControlValidationMiddleware()] });
  const result = await agent.invoke({ messages: [new HumanMessage('Inspect A.')] });
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
  const agent = createAgent({ model, tools: [createSubmitPlanTool(input), createReviewCurrentTool(input), createAdjustPlanTool(input), createDelegateCapabilityTool(input)],
    middleware: [createSupervisorControlValidationMiddleware()] });
  await assert.rejects(agent.invoke({ messages: [new HumanMessage('Inspect A.')] }, { recursionLimit: 6 }),
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
  const tools: StructuredTool[] = [createSubmitPlanTool(input), createReviewCurrentTool(input), createAdjustPlanTool(input), createDelegateCapabilityTool(input), query];
  const agent = createAgent({ model, tools,
    middleware: [createSupervisorControlValidationMiddleware()] });
  await assert.rejects(agent.invoke({ messages: [new HumanMessage('Inspect A.')] }), /only tool call/);
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
        const agent = createAgent({ model, tools: [createSubmitPlanTool(input), createReviewCurrentTool(input), createAdjustPlanTool(input), createDelegateCapabilityTool(input)],
          middleware: [createSupervisorControlValidationMiddleware()] });
        const result = await agent.invoke({ messages: [new HumanMessage('Inspect A.')] });
        assert.equal(result.messages.length, 5);
        assert.deepEqual(Object.keys(result).sort(), ['messages'], 'no supervisorCommand or handoff slot');
        const accepted = acceptSupervisorMessageHandoff(input, createSupervisorMessageHandoff(input, result.messages));
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
  const agent = createAgent({ model, tools: [createSubmitPlanTool(input, 1), createReviewCurrentTool(input, 1), createAdjustPlanTool(input, 1), createDelegateCapabilityTool(input, 1)],
    middleware: [createSupervisorControlValidationMiddleware()] });
  const result = await agent.invoke({ messages: [new HumanMessage('Decide the next step.')] });
  return acceptSupervisorMessageHandoff(input, createSupervisorMessageHandoff(input, result.messages.slice(1)));
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
  assert.equal(JSON.parse(execution.briefing).task, 'Inspect B using A evidence.');
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
  await assert.rejects(agent.invoke({ messages: [new HumanMessage('Read details.')] }), /Read cancelled/);
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
  const paused = await agent.invoke({ messages: [new HumanMessage('Read details.')] }, config);
  assert.equal(paused.__interrupt__?.length, 1);
  assert.equal(model.inputs.length, 1);
  const resumed = await agent.invoke(new Command({ resume: 'Approved details' }), config);
  assert.equal(resumed.messages.at(-1)?.text, 'Read complete.');
  assert.equal(model.inputs.length, 2);
});

test('delegation injects the confirmed task and ordered plan into an immutable briefing', () => {
  const input = context();
  const handoff = createSupervisorMessageHandoff(input, [
    ...control('submit_plan', { tasks: [taskA] }, 'plan'),
    ...control('delegate_capability', {}, 'delegate'),
  ]);
  const dispatch = handoff.at(-1) as AIMessage;
  const record = readCapabilityExecutionCall(dispatch)!;
  assert.deepEqual(record.call.args, {});
  assert.deepEqual(JSON.parse(record.execution.briefing), {
    task: taskA.task, plan: [{ ...taskA, status: 'pending' }],
  });
  assert.equal(record.execution.task, taskA.task);
  assert.equal((record.metadata.execution as { briefing: string }).briefing, record.execution.briefing);
  assert.equal(handoff.filter(m => AIMessage.isInstance(m)
    && m.tool_calls?.some(c => c.name === 'delegate_capability')).length, 1);
  assert.equal(handoff.some(m => ToolMessage.isInstance(m) && m.name === 'delegate_capability'), false);
  const accepted = acceptSupervisorMessageHandoff(input, handoff);
  const result = resultFor(dispatch);
  const tampered = new AIMessage({ ...dispatch, additional_kwargs: structuredClone(dispatch.additional_kwargs) });
  (getAgentMessageMetadata(tampered).execution as { briefing: string }).briefing = 'Execute all future tasks.';
  assert.throws(() => acceptSupervisorMessageHandoff(input, [...handoff.slice(0, -1), tampered]), /does not match/);
  assert.ok(ToolMessage.isInstance(result));
  assert.equal(result.tool_call_id, record.call.id);
  const next = { ...input, state: accepted.runSupervisorState, messages: [...handoff, result], hasNewUserInput: false };
  const changed = acceptSupervisorMessageHandoff(next, createSupervisorMessageHandoff(next, control('adjust_plan', {
    goal: next.state.goal, reason: 'Evidence requires a narrower follow-up.', currentDelegation: 'continue',
    tasks: [{ ...taskA, task: 'Verify only the follow-up.' }],
  }, 'adjust')));
  assert.equal(changed.runSupervisorState.plan[0].task, 'Verify only the follow-up.');
  assert.equal(readCapabilityExecutionCall(dispatch)!.execution.task, taskA.task);
});

test('a historical handoff cannot be resubmitted under a different message id', () => {
  const input = returned();
  const first = input.messages.find(m => AIMessage.isInstance(m)
    && m.tool_calls?.some(c => c.name === 'delegate_capability')) as AIMessage;
  const replay = new AIMessage({ ...first, id: 'different-message-id' });
  assert.throws(() => acceptSupervisorMessageHandoff(input, [replay]), /already accepted/);
});
