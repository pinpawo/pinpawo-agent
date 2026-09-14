import assert from 'node:assert/strict';
import test from 'node:test';
import { AIMessage, HumanMessage, ToolMessage, type BaseMessage } from '@langchain/core/messages';
import { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { tool, type ToolRuntime } from '@langchain/core/tools';
import { Annotation, Command, END, interrupt, MemorySaver, messagesStateReducer, START, StateGraph } from '@langchain/langgraph';
import { ToolNode } from '@langchain/langgraph/prebuilt';
import { createAgent, createMiddleware } from 'langchain';
import { z } from 'zod';

test('one native tool definition transfers through Command.PARENT and resumes in Root ToolNode', async () => {
  let turns = 0;
  let effects = 0;
  class Model extends BaseChatModel {
    _llmType() { return 'native-parent-probe'; }
    bindTools() { return this; }
    async _generate() {
      turns++;
      const message = new AIMessage({ content: '', tool_calls: [{ name: 'delegate_capability', id: 'call-1', args: {} }] });
      return { generations: [{ message, text: '' }] };
    }
  }
  const State = Annotation.Root({
    messages: Annotation<BaseMessage[]>({ reducer: messagesStateReducer, default: () => [] }),
    briefing: Annotation<string>(),
  });
  const delegate = tool((_args, runtime: ToolRuntime<typeof State.State>) => {
    assert.equal(runtime.state.briefing, 'Read the current plan');
    interrupt('Approve');
    effects++;
    return 'Actual delivery';
  }, { name: 'delegate_capability', description: 'Execute current work', schema: z.object({}).strict() });
  const agent = createAgent({ model: new Model({}), tools: [delegate], middleware: [createMiddleware({
    name: 'RootHandoff',
    wrapToolCall: async (request, handler) => request.toolCall.name === delegate.name
      ? new Command({ graph: Command.PARENT, goto: 'capability', update: { messages: request.state.messages.slice(1), briefing: 'Read the current plan' } })
      : handler(request),
  })] });
  const graph = new StateGraph(State)
    .addNode('supervisor', async (_state, config) => {
      await agent.invoke({ messages: [new HumanMessage('Work')] }, config);
      throw new Error('Native parent handoff must bypass this return');
    }, { ends: ['capability'] })
    .addNode('capability', new ToolNode([delegate], { handleToolErrors: false }))
    .addEdge(START, 'supervisor').addEdge('capability', END).compile({ checkpointer: new MemorySaver() });
  const config = { configurable: { thread_id: 'native-parent' } };
  await graph.invoke({ messages: [] }, config);
  assert.equal(turns, 1);
  assert.equal(effects, 0);
  const state = await graph.invoke(new Command({ resume: true }), config);
  assert.equal(turns, 1);
  assert.equal(effects, 1);
  const result = state.messages.at(-1);
  assert.ok(ToolMessage.isInstance(result));
  assert.equal(result.tool_call_id, 'call-1');
  assert.equal(result.text, 'Actual delivery');
});
