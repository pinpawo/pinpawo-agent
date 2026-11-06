import assert from 'node:assert/strict';
import test from 'node:test';
import { AIMessage, HumanMessage, ToolMessage, type BaseMessage } from '@langchain/core/messages';
import { getAgentMessageMetadata, makeToolProtocolSafe } from '../agent/messages';
import { BaseChatModel } from '@langchain/core/language_models/chat_models';
import type { RunnableConfig } from '@langchain/core/runnables';
import { tool } from '@langchain/core/tools';
import { Command, END, interrupt, MemorySaver, MessagesAnnotation, START, StateGraph } from '@langchain/langgraph';
import { countTokensApproximately, createMiddleware } from 'langchain';
import { z } from 'zod';
import { createSubagent, SUBAGENT_BUDGET_HANDOFF_EVENT } from './createSubagent';
import { readSubagentGuardStopReason } from './guardStop';

class RecordingModel extends BaseChatModel {
  calls: Array<{ tools: number; system: string; toolChoice?: unknown; messages: unknown[] }> = [];
  private boundTools = 0;
  private toolChoice: unknown;
  constructor(private readonly respond: (iteration: number) => AIMessage) { super({}); }
  _llmType() { return 'budget-handoff-fixture'; }
  bindTools(tools: unknown[], options?: Record<string, unknown>) {
    this.boundTools = tools.length;
    this.toolChoice = options?.tool_choice;
    return this;
  }
  async _generate(messages: BaseMessage[]) {
    this.calls.push({ tools: this.boundTools, toolChoice: this.toolChoice,
      system: messages.find(message => message._getType() === 'system')?.text ?? '',
      messages: JSON.parse(JSON.stringify(messages.map(message => message.toDict()))),
    });
    this.boundTools = 0;
    const message = this.respond(this.calls.length);
    return { generations: [{ message, text: message.text }] };
  }
}

function call(iteration: number, name = 'noop') {
  return new AIMessage({ content: '', tool_calls: [{ id: `call-${iteration}`, name, args: {} }] });
}

function parent(runChild: (messages: BaseMessage[], config?: RunnableConfig) => Promise<BaseMessage[]>) {
  return new StateGraph(MessagesAnnotation)
    .addNode('child', async (state, config) => ({ messages: await runChild(state.messages, config) }))
    .addEdge(START, 'child').addEdge('child', END);
}

test('budget notifications persist before the model with stable system, tools and input prefixes', async () => {
  let effects = 0;
  const noop = tool(async () => { effects++; return 'ok'; }, { name: 'noop', description: 'noop', schema: z.object({}) });
  const model = new RecordingModel(i => i === 12 ? new AIMessage('partial work and next steps') : call(i));
  let childMessages: BaseMessage[] = [];
  let output: string | null = null;
  let afterModelCalls = 0;
  const probe = createMiddleware({ name: 'AfterModelProbe', afterModel: () => { afterModelCalls++; } });
  const graph = parent(async (messages, runnableConfig) => {
    const result = await createSubagent({ model, tools: [noop], middleware: [probe], promptSections: [], messages, maxIterations: 12, runnableConfig });
    childMessages = result.messages;
    output = result.output;
    return result.messages;
  }).compile();
  const run = await graph.streamEvents({ messages: [new HumanMessage('work')] }, { version: 'v3' });
  const events: Array<{ name?: string; data?: unknown }> = [];
  for await (const event of run) if (event.method === 'custom') events.push(event.params.data as { name?: string; data?: unknown });
  await run.output;
  assert.equal(output, 'partial work and next steps');
  assert.equal(effects, 11);
  assert.equal(afterModelCalls, 12, 'persisting a notification does not run caller afterModel hooks');
  assert.deepEqual(model.calls.map(entry => entry.tools), Array(12).fill(1));
  assert.ok(model.calls.every(entry => entry.system === model.calls[0].system));
  assert.equal(model.calls[11].toolChoice, 'none');
  for (let index = 1; index < model.calls.length; index++) {
    const previous = model.calls[index - 1].messages;
    assert.deepEqual(model.calls[index].messages.slice(0, previous.length), previous, 'model inputs preserve the previous request prefix');
  }
  assert.ok(childMessages.every(message => message._getType() !== 'system'));
  const notices = childMessages.filter(message => getAgentMessageMetadata(message).runtimeNotice === 'subagent_budget');
  assert.equal(notices.length, 4);
  assert.deepEqual(notices.filter(ToolMessage.isInstance).map(message => JSON.parse(message.text).phase), ['prepare', 'finalize']);
  assert.deepEqual(makeToolProtocolSafe(childMessages).removedMessageIds, []);
  assert.deepEqual(events.filter(event => event.name === SUBAGENT_BUDGET_HANDOFF_EVENT).map(event => event.data), [
    { reason: 'model_calls', iteration: 11, maxIterations: 12, remainingModelCalls: 2, phase: 'prepare' },
    { reason: 'model_calls', iteration: 12, maxIterations: 12, remainingModelCalls: 1, phase: 'finalize' },
  ]);
});

test('an agent can return early during the preparation window', async () => {
  const noop = tool(async () => 'ok', { name: 'noop', description: 'noop', schema: z.object({}) });
  const model = new RecordingModel(i => i === 11 ? new AIMessage('partial handoff') : call(i));
  const result = await createSubagent({ model, tools: [noop], promptSections: [], messages: [new HumanMessage('work')], maxIterations: 12 });
  assert.equal(model.calls.length, 11);
  assert.equal(model.calls[10].tools, 1);
  assert.equal(result.output, 'partial handoff');
});

test('checkpoint resume preserves the model budget and reserves its final call', async () => {
  let effects = 0;
  const guarded = tool(async () => { interrupt('approve'); effects++; return 'approved'; }, {
    name: 'guarded', description: 'approval', schema: z.object({}),
  });
  const model = new RecordingModel(i => i === 1 ? call(i, 'guarded') : new AIMessage('handoff after resume'));
  let output: string | null = null;
  const graph = parent(async (messages, runnableConfig) => {
    const result = await createSubagent({ model, tools: [guarded], promptSections: [], messages, maxIterations: 2, runnableConfig });
    output = result.output;
    return result.messages;
  }).compile({ checkpointer: new MemorySaver() });
  const config = { configurable: { thread_id: 'budget-review' } };
  const first = await graph.streamEvents({ messages: [new HumanMessage('work')] }, { version: 'v3', ...config });
  for await (const _event of first) { /* drain */ }
  await first.output;
  assert.ok(first.interrupts.length);
  assert.equal(model.calls.length, 1);
  const resumed = await graph.streamEvents(new Command({ resume: true }), { version: 'v3', ...config });
  for await (const _event of resumed) { /* drain */ }
  await resumed.output;
  assert.equal(effects, 1);
  assert.deepEqual(model.calls.map(entry => entry.tools), [1, 1]);
  assert.equal(model.calls[1].toolChoice, 'none');
  assert.equal(output, 'handoff after resume');
});

test('a forbidden final tool call cannot execute, and an empty final answer is not a delivery', async () => {
  let effects = 0;
  const noop = tool(async () => { effects++; return 'ok'; }, { name: 'noop', description: 'noop', schema: z.object({}) });
  const violating = new RecordingModel(i => call(i));
  const refused = await createSubagent({ model: violating, tools: [noop], promptSections: [], messages: [new HumanMessage('work')], maxIterations: 1 });
  assert.equal(effects, 0);
  assert.equal(refused.output, null);
  assert.equal(readSubagentGuardStopReason(refused.messages.at(-1)!), 'subagent_iteration_limit_reached');
  assert.ok(refused.messages.every(message => !AIMessage.isInstance(message)
    || !message.tool_calls?.some(toolCall => toolCall.name !== 'runtime_budget_status')));
  const noId = new RecordingModel(() => new AIMessage({
    content: '', tool_calls: [{ name: 'noop', args: {} }],
  }));
  const noIdResult = await createSubagent({ model: noId, tools: [noop], promptSections: [], messages: [new HumanMessage('work')], maxIterations: 1 });
  assert.equal(effects, 0);
  assert.equal(noIdResult.output, null);
  assert.ok(noIdResult.messages.every(message => !AIMessage.isInstance(message)
    || !message.tool_calls?.some(toolCall => toolCall.name !== 'runtime_budget_status')));
  const bypass = createMiddleware({ name: 'Bypass', wrapModelCall: () => call(1) });
  const bypassed = await createSubagent({ model: violating, tools: [noop], middleware: [bypass], promptSections: [], messages: [new HumanMessage('work')], maxIterations: 1 });
  assert.equal(effects, 0);
  assert.equal(bypassed.output, null);
  assert.equal(readSubagentGuardStopReason(bypassed.messages.at(-1)!), 'subagent_iteration_limit_reached');
  const empty = new RecordingModel(() => new AIMessage(''));
  const emptyResult = await createSubagent({ model: empty, tools: [noop], promptSections: [], messages: [new HumanMessage('work')], maxIterations: 1 });
  assert.equal(emptyResult.output, null);
  const failing = createMiddleware({ name: 'Failure', wrapModelCall: () => { throw new Error('model unavailable'); } });
  await assert.rejects(createSubagent({ model: empty, tools: [noop], middleware: [failing], promptSections: [], messages: [new HumanMessage('work')], maxIterations: 1 }), /model unavailable/);
});

test('context budget counts composed system sections and tool schemas and reserves generation space', async () => {
  const noop = tool(() => 'unused', {
    name: 'noop', description: 'schema details '.repeat(900), schema: z.object({}),
  });
  const model = new RecordingModel(() => new AIMessage('handoff'));
  const result = await createSubagent({
    model, tools: [noop], promptSections: [{ id: 'capability:large', content: 'evidence '.repeat(1500) }],
    messages: [new HumanMessage('small task')], contextWindowTokens: 12_000, generationReserveTokens: 4_000,
  });
  assert.equal(model.calls.length, 1);
  assert.equal(model.calls[0].toolChoice, 'none');
  const notice = result.messages.find(message => ToolMessage.isInstance(message)
    && message.name === 'runtime_budget_status')!;
  const data = JSON.parse(notice.text);
  assert.equal(data.reason, 'context_window');
  assert.equal(data.inputBudgetTokens, 8_000);
  assert.equal(data.contextWindowTokens, 12_000);
  assert.equal(data.generationReserveTokens, 4_000);
  assert.equal(data.triggerTokens, 6_200);
  assert.ok(data.estimatedInputTokens >= 6_200);
  assert.ok(countTokensApproximately([new HumanMessage('small task')]) < data.triggerTokens);
});

for (const [window, reserve, threshold] of [
  [12_000, 0, 10_200],
  [12_000, 4_000, 6_200],
  [983_616, 147_456, 688_617],
  [1_000_000, 384_000, 466_000],
]) {
  test(`context handoff budgets 85% of the total ${window}-token window with ${reserve} reserved`, async () => {
    let effects = 0;
    const noop = tool(() => { effects++; return 'observed'; }, {
      name: 'noop', description: 'inspect', schema: z.object({}),
    });
    const model = new RecordingModel(i => {
      if (i === 3) return new AIMessage('handoff');
      const message = call(i);
      const input = i === 1 ? threshold - 200 : threshold;
      message.usage_metadata = { input_tokens: input, output_tokens: 10, total_tokens: input + 10 };
      return message;
    });
    const result = await createSubagent({
      model, tools: [noop], promptSections: [], messages: [new HumanMessage('inspect')],
      contextWindowTokens: window, generationReserveTokens: reserve,
    });
    assert.equal(effects, 2, 'work continues below the watermark');
    assert.equal(model.calls.length, 3);
    assert.notEqual(model.calls[1].toolChoice, 'none');
    assert.equal(model.calls[2].toolChoice, 'none');
    assert.equal(result.output, 'handoff', 'the notice leaves enough space for the real handoff call');
    const notices = result.messages.filter(message => ToolMessage.isInstance(message)
      && message.name === 'runtime_budget_status');
    assert.equal(notices.length, 1);
    const data = JSON.parse(notices[0].text);
    assert.equal(data.reason, 'context_window');
    assert.equal(data.contextWindowTokens, window);
    assert.equal(data.generationReserveTokens, reserve);
    assert.equal(data.triggerTokens, threshold);
    assert.ok(data.estimatedInputTokens + reserve >= Math.floor(window * 0.85));
    assert.ok(data.estimatedInputTokens < data.inputBudgetTokens);
    assert.deepEqual(makeToolProtocolSafe(result.messages).removedMessageIds, []);
  });
}

test('context finalization blocks violating tool calls even when caller middleware bypasses the model', async () => {
  let effects = 0;
  let responses = 0;
  const noop = tool(() => { effects++; return 'observed'; }, {
    name: 'noop', description: 'inspect', schema: z.object({}),
  });
  const bypass = createMiddleware({
    name: 'BypassContextFinal', wrapModelCall: (request, handler) => {
      if (request.messages.some(message => ToolMessage.isInstance(message)
        && message.name === 'runtime_budget_status' && JSON.parse(message.text).reason === 'context_window')) {
        return call(2);
      }
      return handler(request);
    },
  });
  const model = new RecordingModel(() => {
    responses++;
    return new AIMessage({ content: '', tool_calls: [{ id: 'first', name: 'noop', args: {} }],
      usage_metadata: { input_tokens: 11_000, output_tokens: 10, total_tokens: 11_010 } });
  });
  const result = await createSubagent({
    model, tools: [noop], middleware: [bypass], promptSections: [],
    messages: [new HumanMessage('inspect')], contextWindowTokens: 12_000,
  });
  assert.equal(responses, 1);
  assert.equal(effects, 1, 'only the first, budget-permitted operation executes');
  assert.equal(result.output, null);
  assert.equal(readSubagentGuardStopReason(result.messages.at(-1)!), 'subagent_context_limit_reached');
  assert.deepEqual(makeToolProtocolSafe(result.messages).removedMessageIds, []);
});

test('provider usage from parent history does not consume a new delegation context budget', async () => {
  const model = new RecordingModel(() => new AIMessage('fresh result'));
  const result = await createSubagent({
    model, tools: [], promptSections: [], contextWindowTokens: 12_000,
    messages: [new AIMessage({ content: 'parent result',
      usage_metadata: { input_tokens: 50_000, output_tokens: 10, total_tokens: 50_010 } }),
    new HumanMessage('new delegation')],
  });
  assert.equal(result.output, 'fresh result');
  assert.equal(model.calls.length, 1);
  assert.ok(!result.messages.some(message => ToolMessage.isInstance(message)
    && message.name === 'runtime_budget_status'));
});

test('a later missing usage report retains the provider anchor plus all intervening growth', async () => {
  let effects = 0;
  const observe = tool(() => ++effects === 1 ? 'small result' : 'x'.repeat(8_000), {
    name: 'noop', description: 'observe', schema: z.object({}),
  });
  const model = new RecordingModel(i => {
    if (i === 3) return new AIMessage('context handoff');
    const message = call(i);
    if (i === 1) message.usage_metadata = { input_tokens: 12_000, output_tokens: 10, total_tokens: 12_010 };
    return message;
  });
  const result = await createSubagent({
    model, tools: [observe], promptSections: [], messages: [new HumanMessage('inspect')],
    contextWindowTokens: 16_000,
  });
  assert.equal(effects, 2);
  assert.equal(model.calls.length, 3);
  assert.equal(model.calls[2].toolChoice, 'none');
  const notice = result.messages.find(message => ToolMessage.isInstance(message)
    && message.name === 'runtime_budget_status')!;
  const data = JSON.parse(notice.text);
  assert.equal(data.reason, 'context_window');
  assert.ok(data.estimatedInputTokens >= 14_000);
});
