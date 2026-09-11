import assert from 'node:assert/strict';
import test from 'node:test';
import { AIMessage, HumanMessage, RemoveMessage, ToolMessage, type BaseMessage } from '@langchain/core/messages';
import { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { tool } from '@langchain/core/tools';
import { Annotation, Command, END, interrupt, MemorySaver, messagesStateReducer, REMOVE_ALL_MESSAGES, START, StateGraph } from '@langchain/langgraph';
import { ToolNode } from '@langchain/langgraph/prebuilt';
import { createAgent, createMiddleware } from 'langchain';
import { z } from 'zod';
import { createCapabilityExecutor } from '../../src/agent/orchestrator/capabilityExecution';
import { compileAgentRegistry } from '../../src/agent/orchestrator/registry';
import { defineInstructionDocument } from '../../src/types/capability';

// Architecture experiment only: real createAgent + Root ToolNode, scripted models.
// No production routing changes, external tools, model API calls or credentials.
class ScriptedModel extends BaseChatModel {
  readonly inputs: BaseMessage[][] = [];
  private index = 0;
  constructor(private readonly responses: AIMessage[]) { super({}); }
  _llmType() { return 'root-tool-node-experiment'; }
  bindTools() { return this; }
  async _generate(messages: BaseMessage[]) {
    this.inputs.push(messages);
    const message = this.responses[this.index++];
    assert.ok(message, 'unexpected model invocation');
    return { generations: [{ message, text: message.text }] };
  }
}

const expectedTask = { capability: 'general', task: 'Inspect without modifying files.' };
const taskSchema = z.object({ capability: z.string(), task: z.string() }).strict();
const call = (name: string, args: Record<string, unknown>, id: string) =>
  new AIMessage({ content: '', tool_calls: [{ name, args, id, type: 'tool_call' }] });
const delegate = (id: string) => call('delegate_capability', expectedTask, id);
const options = (thread: string) => ({ configurable: { thread_id: thread } });

const RootState = Annotation.Root({
  messages: Annotation<BaseMessage[]>({ reducer: messagesStateReducer, default: () => [] }),
  supervisorMessages: Annotation<BaseMessage[]>({ reducer: messagesStateReducer, default: () => [] }),
  runId: Annotation<string>({ reducer: (_, next) => next, default: () => '' }),
  deliveries: Annotation<string[]>({ reducer: (prev, next) => [...prev, ...next], default: () => [] }),
});

function setup(responses: AIMessage[], review = false, useProductionExecutor = false) {
  const supervisor = new ScriptedModel(responses);
  const child = new ScriptedModel(review ? [
    call('inspect', {}, 'child-inspect'), new AIMessage('Inspection evidence.'),
  ] : [new AIMessage('Inspection evidence.'), new AIMessage('Additional evidence.')]);
  const saver = new MemorySaver();
  const counters = { local: 0, rootTools: 0, childEffects: 0, entry: 0 };

  function build() {
    const localTool = tool(() => { counters.local += 1; return 'Capability details.'; }, {
      name: 'capability_details', description: 'Read capability details.', schema: z.object({}),
    });
    const inspect = tool(() => {
      if (review) {
        const approved = interrupt({ kind: 'experiment_review' });
        if (approved !== true) return 'Inspection rejected.';
      }
      counters.childEffects += 1;
      return 'Inspected.';
    }, { name: 'inspect', description: 'Inspect after review.', schema: z.object({}) });
    const delegationTool = tool(async (args, config) => {
      assert.deepEqual(args, expectedTask);
      counters.rootTools += 1;
      if (useProductionExecutor) {
        const registry = compileAgentRegistry({ toolkits: [], capabilities: [{
          name: 'general', description: 'Inspect.', uses: [],
          instructions: defineInstructionDocument({ content: 'Inspect the delegated task and return evidence.' }),
        }] });
        const execute = createCapabilityExecutor({ models: { act: child, subagent: child } });
        const result = await execute({
          capability: registry.capabilities[0],
          delegation: {
            id: 'delegation-1', runId: 'business-run-1', traceId: 'task-1', mode: 'initial',
            userRequest: args.task, task: args.task, essentialContext: null,
          },
          history: [new HumanMessage({ id: 'executor-input', content: args.task })],
        }, { review: { authorizations: [] }, runnableConfig: config });
        assert.equal(result.status, 'returned');
        return JSON.stringify({ status: result.status, delivery: result.delivery, artifacts: result.artifacts });
      }
      const executor = createAgent({ name: 'experiment-executor', model: child, tools: [inspect] });
      const output = await executor.invoke({ messages: [new HumanMessage(args.task)] }, config);
      return output.messages.at(-1)!.text;
    }, { name: 'delegate_capability', description: 'Execute the confirmed task.', schema: taskSchema });

    const yieldDelegation = createMiddleware({
      name: 'YieldDelegationToRoot',
      afterModel: {
        canJumpTo: ['end'],
        hook: (state) => {
          const last = state.messages.at(-1);
          const calls = AIMessage.isInstance(last) ? last.tool_calls ?? [] : [];
          if (!calls.some((item) => item.name === 'delegate_capability')) return;
          assert.equal(calls.length, 1, 'delegation must be exclusive');
          assert.ok(calls[0].id, 'delegation requires call identity');
          assert.deepEqual(taskSchema.parse(calls[0].args), expectedTask);
          return { jumpTo: 'end' as const };
        },
      },
    });
    const agent = createAgent({
      name: 'experiment-supervisor', model: supervisor,
      tools: [localTool, delegationTool], middleware: [yieldDelegation],
    });
    const rootTools = new ToolNode([delegationTool], { handleToolErrors: false });
    return new StateGraph(RootState)
      // Minimal entry stub, not a test of production Entry Answer's routing policy.
      .addNode('entryAnswer', (state) => {
        counters.entry += 1;
        return { supervisorMessages: [
          new RemoveMessage({ id: REMOVE_ALL_MESSAGES }),
          new HumanMessage(state.messages.at(-1)!.text),
        ] };
      })
      .addNode('supervisor', async (state, config) => {
        const result = await agent.invoke({ messages: state.supervisorMessages }, config);
        return { supervisorMessages: result.messages };
      })
      .addNode('capability', async (state, config) => {
        const last = state.supervisorMessages.at(-1);
        assert.ok(AIMessage.isInstance(last));
        assert.equal(last.tool_calls?.length, 1);
        assert.equal(last.tool_calls[0].name, 'delegate_capability');
        const result = await rootTools.invoke({ messages: state.supervisorMessages }, config);
        assert.equal(result.messages.length, 1);
        assert.ok(ToolMessage.isInstance(result.messages[0]));
        assert.equal(result.messages[0].tool_call_id, last.tool_calls[0].id);
        return { supervisorMessages: result.messages, deliveries: [result.messages[0].text] };
      })
      .addNode('answer', (state) => ({ messages: [new AIMessage(state.supervisorMessages.at(-1)!.text)] }))
      .addEdge(START, 'entryAnswer')
      .addEdge('entryAnswer', 'supervisor')
      .addConditionalEdges('supervisor', (state) => {
        const last = state.supervisorMessages.at(-1);
        return AIMessage.isInstance(last) && last.tool_calls?.length ? 'capability' : 'answer';
      }, ['capability', 'answer'])
      .addEdge('capability', 'supervisor')
      .addEdge('answer', END)
      .compile({ checkpointer: saver });
  }
  const input = {
    runId: 'business-run-1',
    messages: [new HumanMessage(expectedTask.task)],
    supervisorMessages: [new HumanMessage(expectedTask.task)],
  };
  return { build, input, supervisor, counters };
}

test('ordinary tools stay in createAgent; two delegation calls execute at Root and pair exactly', async () => {
  const f = setup([
    call('capability_details', {}, 'details'), delegate('attempt-1'), delegate('attempt-2'), new AIMessage('Done.'),
  ]);
  const out = await f.build().invoke(f.input, options('normal'));
  assert.equal(f.counters.local, 1);
  assert.equal(f.counters.rootTools, 2);
  assert.equal(f.supervisor.inputs.length, 4);
  assert.equal(out.deliveries.length, 2);
  const results = f.supervisor.inputs.at(-1)!.filter((m) => ToolMessage.isInstance(m) && m.name === 'delegate_capability');
  assert.deepEqual(results.map((m) => (m as ToolMessage).tool_call_id), ['attempt-1', 'attempt-2']);
  assert.equal(out.messages.some((m) => ToolMessage.isInstance(m)), false);
  assert.equal(out.messages.at(-1)?.text, 'Done.');
});

test('restart before Root tool execution does not rerun Supervisor or execute the tool internally', async () => {
  const f = setup([delegate('dispatch'), new AIMessage('Done.')]);
  const config = options('before-tool');
  await f.build().invoke(f.input, { ...config, interruptBefore: ['capability'] });
  assert.equal(f.counters.rootTools, 0);
  assert.equal(f.supervisor.inputs.length, 1);
  const out = await f.build().invoke(null, config);
  assert.equal(f.counters.rootTools, 1);
  assert.equal(f.supervisor.inputs.length, 2);
  assert.equal(f.counters.entry, 1);
  assert.equal(out.runId, f.input.runId);
});

test('restart after committed tool result does not repeat execution', async () => {
  const f = setup([delegate('dispatch'), new AIMessage('Done.')]);
  const config = options('after-tool');
  await f.build().invoke(f.input, { ...config, interruptAfter: ['capability'] });
  assert.equal(f.counters.rootTools, 1);
  assert.equal(f.supervisor.inputs.length, 1);
  const out = await f.build().invoke(null, config);
  assert.equal(f.counters.rootTools, 1);
  assert.equal(out.deliveries.length, 1);
  assert.equal(f.supervisor.inputs.length, 2);
});

test('child review interrupt resumes same business run and original delegation call', async () => {
  const f = setup([delegate('review-call'), new AIMessage('Done.')], true);
  const config = options('review');
  await f.build().invoke(f.input, config);
  assert.equal(f.counters.childEffects, 0);
  assert.equal(f.supervisor.inputs.length, 1);
  const checkpoint = await f.build().getState(config);
  assert.equal(checkpoint.values.deliveries.length, 0);
  const out = await f.build().invoke(new Command({ resume: true }), config);
  assert.equal(f.counters.childEffects, 1);
  assert.equal(out.runId, f.input.runId);
  assert.equal(f.counters.entry, 1);
  assert.equal(out.deliveries.length, 1);
  const results = out.supervisorMessages.filter((m) => ToolMessage.isInstance(m) && m.tool_call_id === 'review-call');
  assert.equal(results.length, 1);
});

test('mixed delegation response is rejected before either tool runs', async () => {
  const invalid = new AIMessage({ content: '', tool_calls: [
    { name: 'capability_details', args: {}, id: 'details', type: 'tool_call' },
    { name: 'delegate_capability', args: expectedTask, id: 'dispatch', type: 'tool_call' },
  ] });
  const f = setup([invalid]);
  await assert.rejects(f.build().invoke(f.input, options('invalid')), /delegation must be exclusive/);
  assert.equal(f.counters.local, 0);
  assert.equal(f.counters.rootTools, 0);
});

test('Root native stream exposes Capability model messages', async () => {
  const f = setup([delegate('stream-call'), new AIMessage('Done.')]);
  const run = await f.build().streamEvents(f.input, { ...options('stream'), version: 'v3' });
  let capabilityEvents = 0;
  for await (const event of run) {
    if (event.method === 'messages' && event.params.namespace?.some((part) => part.startsWith('capability:'))) {
      capabilityEvents += 1;
    }
  }
  await run.output;
  assert.ok(capabilityEvents > 0, 'Capability model messages must remain visible on Root stream');
});

test('next business run on the same thread starts with clean Supervisor working messages', async () => {
  const f = setup([delegate('old-call'), new AIMessage('First done.'), new AIMessage('Second done.')]);
  const config = options('two-runs');
  await f.build().invoke(f.input, config);
  const out = await f.build().invoke({
    runId: 'business-run-2', messages: [new HumanMessage('New independent request.')],
  }, config);
  assert.equal(out.runId, 'business-run-2');
  assert.equal(f.counters.entry, 2);
  assert.equal(f.counters.rootTools, 1);
  assert.equal(out.deliveries.length, 1);
  assert.equal(f.supervisor.inputs.at(-1)!.length, 1);
  assert.equal(f.supervisor.inputs.at(-1)![0].text, 'New independent request.');
});

test('mismatched delegation arguments fail before execution', async () => {
  const f = setup([call('delegate_capability', { ...expectedTask, task: 'Different task.' }, 'invalid')]);
  await assert.rejects(f.build().invoke(f.input, options('mismatch')));
  assert.equal(f.counters.rootTools, 0);
});

test('Root tool can invoke the unchanged production Capability executor and stream its model output', async () => {
  const f = setup([delegate('production-call'), new AIMessage('Done.')], false, true);
  const run = await f.build().streamEvents(f.input, { ...options('production-executor'), version: 'v3' });
  let capabilityEvents = 0;
  for await (const event of run) {
    if (event.method === 'messages' && event.params.namespace?.some((part) => part.startsWith('capability:'))) {
      capabilityEvents += 1;
    }
  }
  const out = await run.output;
  assert.ok(capabilityEvents > 0);
  assert.equal(f.counters.rootTools, 1);
  const result = out.supervisorMessages.find((m) => ToolMessage.isInstance(m) && m.tool_call_id === 'production-call');
  assert.ok(result);
  assert.equal(JSON.parse(result.text).delivery.text, 'Inspection evidence.');
});
