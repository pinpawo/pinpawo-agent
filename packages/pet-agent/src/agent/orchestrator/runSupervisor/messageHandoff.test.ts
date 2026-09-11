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
  createMessageSupervisorControlTools,
  createSupervisorControlValidationMiddleware,
  createSupervisorMessageHandoff,
  type SupervisorHandoffContext,
} from './messageHandoff';

import { capabilityHandoffSchema } from './protocol';
import { executionsForTask } from '../executionMessages';

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
  const { execution } = capabilityHandoffSchema.parse(dispatch.tool_calls![0].args);
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
  const handoff = createSupervisorMessageHandoff(firstContext, control('submit_plan', { tasks }));
  const accepted = acceptSupervisorMessageHandoff(firstContext, handoff);
  const dispatch = handoff.at(-1) as AIMessage;
  return {
    ...firstContext, state: accepted.runSupervisorState,
    messages: [...firstContext.messages, ...handoff, resultFor(dispatch)], mode: 'boundary' as const,
  };
}

test('handoff is two independent call pairs, with no proposal or pending state', () => {
  const input = context();
  const internal = control('submit_plan', { tasks: [taskA, taskB] });
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
  assert.equal(getAgentMessageMetadata(dispatch).sourceControlCallId, 'control-1');
  assert.equal(getAgentMessageMetadata(dispatch).runtimeGenerated, true);
  const main = queryAgentMessages([...handoff, resultFor(dispatch)]).main().select().messages;
  assert.equal(main.length, 2);
  assert.equal((main[1] as ToolMessage).tool_call_id, dispatch.tool_calls![0].id);
  assert.equal(queryAgentMessages(handoff).supervisor('r1').select().messages.length, 2);
});

test('accepted A may end the run with a question, then Boundary starts B without active delegation', () => {
  const first = returned();
  const accepted = acceptSupervisorMessageHandoff(first, createSupervisorMessageHandoff(first,
    control('review_current', { completed: true, reason: 'Evidence verified.', reply: 'Shall I inspect B?' }, 'review-A')));
  assert.equal(accepted.messages.length, 2, 'no execution call when replying');
  assert.equal(accepted.runSupervisorState.plan[0].status, 'completed');
  const next = context({ ...first, runId: 'r2', state: accepted.runSupervisorState,
    messages: [...first.messages, ...accepted.messages, new HumanMessage('Yes, proceed.')],
  });
  const handoff = createSupervisorMessageHandoff(next,
    control('review_current', { reason: 'Proceed with the agreed remaining plan.' }, 'start-B'));
  const execution = capabilityHandoffSchema.parse((handoff.at(-1) as AIMessage).tool_calls![0].args).execution;
  assert.equal(execution.task, taskB.task);
  assert.equal(execution.mode, 'initial');
  assert.equal(acceptSupervisorMessageHandoff(next, handoff).runSupervisorState.plan[0].status, 'completed');
});

test('a review question can defer acceptance without dispatching or changing returned progress', () => {
  const input = returned();
  const handoff = createSupervisorMessageHandoff(input, control('review_current', {
    reason: 'Only the user can select the destination.', reply: 'Which destination?',
  }, 'question'));
  const accepted = acceptSupervisorMessageHandoff(input, handoff);
  assert.deepEqual(accepted.runSupervisorState, input.state);
  assert.equal(accepted.reply, 'Which destination?');
  assert.equal(accepted.messages.length, 2);
  assert.equal(queryAgentMessages(handoff).main().select().messages.length, 0);
  assert.throws(() => createSupervisorMessageHandoff(input, control('review_current', {
    reason: 'No decision and no reply.',
  }, 'missing-decision')), /must decide/);
});

test('a failed retry cannot be accepted using an older successful delivery', () => {
  const first = returned();
  const retry = createSupervisorMessageHandoff(first,
    control('review_current', { completed: false, reason: 'Verify missing evidence.' }, 'retry-failed'));
  const dispatch = retry.at(-1) as AIMessage;
  for (const status of ['missing_deliverable', 'paused']) {
    const result = setAgentMessageMetadata(new ToolMessage({ name: 'delegate_capability',
      tool_call_id: dispatch.tool_calls![0].id!, status: status === 'missing_deliverable' ? 'error' : 'success',
      content: JSON.stringify({ status, delivery: null, artifacts: [] }),
    }), getAgentMessageMetadata(dispatch));
    const input = { ...first, messages: [...first.messages, ...retry, result] };
    assert.equal(executionsForTask(input, first.state.plan[0].id).at(-1)?.result?.status, status);
    assert.throws(() => createSupervisorMessageHandoff(input,
      control('review_current', { completed: true, reason: 'Old evidence is enough.', reply: 'Done.' }, 'accept-failed')), /returned delivery/);
    assert.equal(createSupervisorMessageHandoff(input,
      control('review_current', { completed: false, reason: 'Try producing a new deliverable.' }, 'retry-again')).length, 3);
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
      control('review_current', { completed: true, reason: 'Verify result.', reply: 'Done.' }, 'bad-evidence')), /returned delivery/);
  }
});

test('same-run retries keep execution scope; new runs never inherit the old delegation instance', () => {
  const first = returned();
  const retry = control('review_current', { completed: false, reason: 'Check the missing detail.' }, 'retry');
  const oldDispatch = first.messages.find((message) => AIMessage.isInstance(message)
    && message.tool_calls?.[0]?.name === 'delegate_capability') as AIMessage;
  const oldExecution = capabilityHandoffSchema.parse(oldDispatch.tool_calls![0].args).execution;
  const same = createSupervisorMessageHandoff(first, retry).at(-1) as AIMessage;
  const sameExecution = capabilityHandoffSchema.parse(same.tool_calls![0].args).execution;
  assert.equal(sameExecution.delegationId, oldExecution.delegationId);
  assert.equal(sameExecution.mode, 'continue');
  const fresh = createSupervisorMessageHandoff({ ...first, runId: 'r2' }, retry).at(-1) as AIMessage;
  const freshExecution = capabilityHandoffSchema.parse(fresh.tool_calls![0].args).execution;
  assert.notEqual(freshExecution.delegationId, oldExecution.delegationId);
  assert.equal(freshExecution.mode, 'initial');
  assert.notEqual(fresh.tool_calls![0].id, same.tool_calls![0].id);
  assert.equal(queryAgentMessages(first.messages).supervisor('r2').select().messages.length, 0);
});

test('handoff rejects unexecuted, mixed, mismatched, unavailable and replayed calls', () => {
  const input = context();
  const pair = control('submit_plan', { tasks: [taskA] });
  assert.throws(() => createSupervisorMessageHandoff(input, pair.slice(0, 1)), /completed exclusive/);
  assert.throws(() => createSupervisorMessageHandoff(input, [pair[0], new ToolMessage({
    content: 'submitted', name: 'submit_plan', tool_call_id: 'wrong',
  })]), /does not match/);
  assert.throws(() => createSupervisorMessageHandoff(input, [pair[0], new ToolMessage({
    content: 'tool execution failed', status: 'error', name: 'submit_plan', tool_call_id: 'control-1',
  })]), /completed exclusive/);
  const mixed = new AIMessage({ content: '', tool_calls: [
    { name: 'submit_plan', args: { tasks: [taskA] }, id: 'control-1' },
    { name: 'capability_details', args: { names: ['general'] }, id: 'details' },
  ] });
  assert.throws(() => createSupervisorMessageHandoff(input, [mixed, pair[1]]), /exclusive/);
  assert.throws(() => createSupervisorMessageHandoff({ ...input, allowedCapabilityNames: [] }, pair), /catalog/);
  const handoff = createSupervisorMessageHandoff(input, pair);
  assert.throws(() => acceptSupervisorMessageHandoff(input, handoff.slice(0, 2)), /omitted/);
  const altered = new AIMessage({ ...(handoff.at(-1) as AIMessage) });
  altered.tool_calls = structuredClone(altered.tool_calls);
  (altered.tool_calls![0].args.execution as { task: string }).task = 'Different work';
  assert.throws(() => acceptSupervisorMessageHandoff(input, [...handoff.slice(0, 2), altered]), /does not match/);
  assert.throws(() => acceptSupervisorMessageHandoff({ ...input, messages: handoff }, handoff), /already accepted/);
  assert.throws(() => createSupervisorMessageHandoff({ ...returned(), messages: [] },
    control('review_current', { completed: true, reason: 'Unsubstantiated claim.', reply: 'Done.' })), /delivery/);
});

test('plan adjustment preserves completed work and validates fresh user input', () => {
  const input = returned();
  const completed = acceptSupervisorMessageHandoff(input, createSupervisorMessageHandoff(input,
    control('review_current', { completed: true, reason: 'Verified.', reply: 'Awaiting choice.' }, 'accept')));
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

test('replacing executed but unaccepted work preserves it as superseded, not pending', () => {
  const input = returned();
  const handoff = createSupervisorMessageHandoff(input, control('adjust_plan', {
    goal: 'Changed goal', reason: 'User replaced the work.', currentDelegation: 'replace', tasks: [taskB],
  }, 'replace-executed'));
  const accepted = acceptSupervisorMessageHandoff(input, handoff);
  assert.deepEqual(accepted.runSupervisorState.plan.map(({ status }) => status), ['superseded', 'pending']);
  assert.equal(accepted.runSupervisorState.plan[0].id, input.state.plan[0].id);
  assert.notEqual(accepted.runSupervisorState.plan[1].id, input.state.plan[1].id);
});

class OneControlModel extends BaseChatModel {
  invocations = 0;
  _llmType() { return 'single-control'; }
  bindTools() { return this; }
  async _generate(): Promise<ChatResult> {
    if (++this.invocations > 1) throw new Error('Unexpected extra model dispatch');
    const message = control('submit_plan', { tasks: [taskA] })[0] as AIMessage;
    return { generations: [{ message, text: '' }] };
  }
}

test('unavailable model tools fail before an extra model loop or tool execution', async () => {
  for (const name of ['delegate_capability', 'unknown_tool', 'capability_details', 'submit_plan', 'adjust_plan']) {
    class UnavailableModel extends OneControlModel {
      async _generate(): Promise<ChatResult> {
        this.invocations++;
        const message = new AIMessage({ content: '', tool_calls: [{ name, args: {}, id: 'unknown' }] });
        return { generations: [{ message, text: '' }] };
      }
    }
    const input = context({ mode: 'boundary', hasNewUserInput: false });
    const model = new UnavailableModel({});
    const agent = createAgent({ model, tools: createMessageSupervisorControlTools(input),
      middleware: [createSupervisorControlValidationMiddleware(input)] });
    await assert.rejects(agent.invoke({ messages: [new HumanMessage('Continue.')] }), /unavailable/);
    assert.equal(model.invocations, 1);
  }
});

test('internal confirmation does not accept an invalid business decision; handoff rejects it without mutating Root', async () => {
  const input = context({ allowedCapabilityNames: [] });
  const before = JSON.stringify(input);
  const model = new OneControlModel({});
  const agent = createAgent({ model, tools: createMessageSupervisorControlTools(input),
    middleware: [createSupervisorControlValidationMiddleware(input)] });
  const result = await agent.invoke({ messages: [new HumanMessage('Inspect A.')] });
  assert.ok(ToolMessage.isInstance(result.messages.at(-1)));
  assert.equal(model.invocations, 1);
  assert.throws(() => createSupervisorMessageHandoff(input, result.messages), /outside the current catalog/);
  assert.throws(() => acceptSupervisorMessageHandoff(input, result.messages), /outside the current catalog/);
  assert.equal(JSON.stringify(input), before);
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
  const tools: StructuredTool[] = [...createMessageSupervisorControlTools(input), query];
  const agent = createAgent({ model, tools,
    middleware: [createSupervisorControlValidationMiddleware(input)] });
  await assert.rejects(agent.invoke({ messages: [new HumanMessage('Inspect A.')] }), /only tool call/);
  assert.equal(queries, 0);
});

test('real createAgent exits with a complete control pair and Root resumes its execution call from checkpoint', async () => {
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
        const agent = createAgent({ model, tools: createMessageSupervisorControlTools(input),
          middleware: [createSupervisorControlValidationMiddleware(input)] });
        const result = await agent.invoke({ messages: [new HumanMessage('Inspect A.')] });
        assert.equal(result.messages.length, 3);
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
  assert.equal(model.invocations, 1);
  const callId = (checkpoint.values.messages.at(-1) as AIMessage).tool_calls![0].id;
  const resumed = await graph().invoke(new Command({ resume: true }), options);
  assert.equal(executed, 1);
  assert.equal(model.invocations, 1);
  assert.equal((resumed.messages.at(-1) as ToolMessage).tool_call_id, callId);
  assert.equal(currentSupervisorTask(resumed.runSupervisorState)?.status, 'pending');
});
