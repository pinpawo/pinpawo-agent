import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { AIMessage, HumanMessage, SystemMessage, ToolMessage, type BaseMessage } from '@langchain/core/messages';
import { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { tool, type ToolRuntime } from '@langchain/core/tools';
import { Command, END, MemorySaver, MessagesAnnotation, START, StateGraph, interrupt } from '@langchain/langgraph';
import type { RunnableConfig } from '@langchain/core/runnables';
import { z } from 'zod';
import { createSubagent, SUBAGENT_PROMPT_SECTIONS_EVENT } from './createSubagent';
import type { SubagentRuntimeContext } from '../types/subagent';
import { getAgentRuntimeContext } from '../runtime/context';

class ContextModel extends BaseChatModel {
  constructor(private readonly seen: BaseMessage[][]) { super({}); }
  _llmType() { return 'child-context-recorder'; }
  bindTools() { return this; }
  async _generate(messages: BaseMessage[]) {
    this.seen.push(messages);
    const message = messages.some(ToolMessage.isInstance)
      ? new AIMessage('done')
      : new AIMessage({ content: '', tool_calls: [{ id: 'inspect-call', name: 'inspect_context', args: {} }] });
    return { generations: [{ message, text: message.text }] };
  }
}

function commonSections() {
  return [{ id: 'host:pet', content: randomUUID() }, { id: 'host:policy', content: randomUUID() }];
}

function assertSections(messages: BaseMessage[], expected: ReturnType<typeof commonSections>) {
  const system = messages.filter(SystemMessage.isInstance);
  assert.equal(system.length, 1);
  let position = -1;
  for (const section of expected) {
    assert.equal(system[0].text.split(section.content).length - 1, 1);
    const next = system[0].text.indexOf(section.content);
    assert.ok(next > position);
    position = next;
  }
}

test('concurrent root streams propagate isolated context, callbacks and tool ports into dynamic children', async () => {
  const invocations = new Map<string, BaseMessage[][]>();
  const runtimeContexts: SubagentRuntimeContext[] = [];
  const executionSection = { id: 'execution:test', content: randomUUID() };
  const inspect = tool(async (_args, runtime: ToolRuntime<unknown, SubagentRuntimeContext>) => {
    runtimeContexts.push(runtime.context);
    return 'inspected';
  }, { name: 'inspect_context', description: 'Inspect runtime.', schema: z.object({}) });
  const graph = new StateGraph(MessagesAnnotation).addNode('delegate', async (state, config) => {
    const key = state.messages[0].text;
    const seen: BaseMessage[][] = [];
    invocations.set(key, seen);
    const result = await createSubagent({
      model: new ContextModel(seen), tools: [inspect], messages: state.messages,
      promptSections: [executionSection], runnableConfig: config,
      runtimeContext: {
        executionScope: { threadId: null, runId: key, delegationId: key },
        toolkitRuntimes: { example: { id: key } },
        systemPromptSections: [{ id: 'host:forbidden-child-override', content: 'override' }],
      },
    });
    return { messages: result.messages };
  }).addEdge(START, 'delegate').addEdge('delegate', END).compile();
  const inputs = [commonSections(), commonSections()];
  await Promise.all(inputs.map(async (sections, index) => {
    const key = `pet-${index}`;
    const callbackInputs: BaseMessage[][] = [];
    const run = await graph.streamEvents({ messages: [new HumanMessage(key)] }, {
      version: 'v3', context: { systemPromptSections: sections, parentMarker: key },
      callbacks: [{ handleChatModelStart: async (_model, messages) => { callbackInputs.push(...messages); } }],
    });
    const events = [];
    for await (const event of run) events.push(event);
    const output = await run.output;
    const seen = invocations.get(key) ?? [];
    assert.equal(seen.length, 2);
    assert.equal(callbackInputs.length, 2);
    for (const messages of [...seen, ...callbackInputs]) {
      assertSections(messages, [...sections, executionSection]);
      assert.equal(JSON.stringify(messages).includes(inputs[1 - index][0].content), false);
    }
    assert.equal(output.messages.some(SystemMessage.isInstance), false);
    assert.equal(JSON.stringify(output).includes(sections[0].content), false);
    assert.ok(events.some(event => event.method === 'tools' && event.params.namespace.length > 0));
    const promptEvent = events.find(event => event.method === 'custom'
      && (event.params.data as { name?: string }).name === SUBAGENT_PROMPT_SECTIONS_EVENT);
    assert.ok(promptEvent);
    const diagnostics = (promptEvent.params.data as { data: { sections: Array<{ id: string }> } }).data.sections;
    assert.deepEqual(diagnostics.map(s => s.id), ['framework:governing', ...sections.map(s => s.id), executionSection.id]);
  }));
  assert.equal(runtimeContexts.length, 2);
  for (const context of runtimeContexts) {
    const key = context.executionScope?.runId;
    assert.equal(context.parentMarker, key);
    assert.deepEqual(context.toolkitRuntimes, { example: { id: key } });
    const index = key === 'pet-0' ? 0 : 1;
    assert.deepEqual(context.systemPromptSections, inputs[index]);
  }
});

test('checkpoint resume reapplies root context to the interrupted child without checkpointing prompt content', async () => {
  const seen: BaseMessage[][] = [];
  const inspect = tool(async () => {
    interrupt({ kind: 'context-test' });
    return 'resumed';
  }, { name: 'inspect_context', description: 'Pause for review.', schema: z.object({}) });
  const graph = new StateGraph(MessagesAnnotation).addNode('delegate', async (state, config) => {
    const result = await createSubagent({
      model: new ContextModel(seen), tools: [inspect], promptSections: [],
      messages: state.messages, runnableConfig: config,
    });
    return { messages: result.messages };
  }).addEdge(START, 'delegate').addEdge('delegate', END).compile({ checkpointer: new MemorySaver() });
  const before = commonSections();
  const after = commonSections();
  const configurable = { thread_id: randomUUID() };
  await graph.invoke({ messages: [new HumanMessage('resume')] }, { configurable, context: { systemPromptSections: before } });
  const snapshot = await graph.getState({ configurable });
  assert.ok(snapshot.tasks.some(task => task.interrupts?.length));
  assert.equal(JSON.stringify(snapshot.values).includes(before[0].content), false);
  const output = await graph.invoke(new Command({ resume: true }), { configurable, context: { systemPromptSections: after } });
  assert.equal(seen.length, 2);
  assertSections(seen[0], before);
  assertSections(seen[1], after);
  assert.equal(JSON.stringify(seen[1]).includes(before[0].content), false);
  assert.equal(output.messages.at(-1)?.text, 'done');
});

test('child preserves parent cancellation when no separate child signal is supplied', async () => {
  const controller = new AbortController();
  let seenSignal: AbortSignal | undefined;
  let markStarted!: () => void;
  const started = new Promise<void>(resolve => { markStarted = resolve; });
  class WaitingModel extends BaseChatModel {
    _llmType() { return 'waiting-context-recorder'; }
    bindTools() { return this; }
    async _generate(_messages: BaseMessage[], options: this['ParsedCallOptions']): Promise<never> {
      seenSignal = options.signal;
      markStarted();
      return new Promise((_resolve, reject) => {
        const abort = () => reject(options.signal?.reason ?? new Error('Aborted'));
        if (options.signal?.aborted) abort();
        else options.signal?.addEventListener('abort', abort, { once: true });
      });
    }
  }
  const graph = new StateGraph(MessagesAnnotation).addNode('delegate', async (state, config?: RunnableConfig) => {
    const result = await createSubagent({
      model: new WaitingModel({}), tools: [], promptSections: [], messages: state.messages,
      runnableConfig: config,
    });
    return { messages: result.messages };
  }).addEdge(START, 'delegate').addEdge('delegate', END).compile();
  const run = graph.invoke({ messages: [new HumanMessage('cancel')] }, {
    signal: controller.signal, context: getAgentRuntimeContext({ context: { systemPromptSections: commonSections() } }),
  });
  const rejected = assert.rejects(run);
  await started;
  controller.abort(new Error('test cancellation'));
  await rejected;
  assert.equal(seenSignal?.aborted, true);
});
