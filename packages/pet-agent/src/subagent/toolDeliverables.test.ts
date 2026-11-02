import assert from 'node:assert/strict';
import test from 'node:test';
import { assertToolDeliverables, createToolDeliverables } from '@pinpawo/agent-contracts';
import { AIMessage, HumanMessage, ToolMessage, type BaseMessage } from '@langchain/core/messages';
import { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { tool, type StructuredTool } from '@langchain/core/tools';
import { convertToOpenAITool } from '@langchain/core/utils/function_calling';
import { Command, MemorySaver, StateSchema, interrupt, isCommand } from '@langchain/langgraph';
import { createAgent, createMiddleware, type AnyAgentMiddleware } from 'langchain';
import { z } from 'zod';
import { z as z4 } from 'zod/v4';
import { createToolDeliverablesCollector } from './toolDeliverables';

const declaration = createToolDeliverables([
  { uri: 'artifact://reports/result', title: 'Result' },
]);

class CallingModel extends BaseChatModel {
  modelCalls = 0;
  constructor(private readonly calls: { name: string; id: string; args: Record<string, unknown> }[]) { super({}); }
  _llmType() { return 'deliverables-collector-fixture'; }
  bindTools() { return this; }
  async _generate(messages: BaseMessage[]) {
    this.modelCalls++;
    const message = messages.some(ToolMessage.isInstance)
      ? new AIMessage('Done.') : new AIMessage({ content: '', tool_calls: this.calls });
    return { generations: [{ message, text: message.text }] };
  }
}

function graphFor(tools: StructuredTool[], enabled: boolean, existing: AnyAgentMiddleware[] = []) {
  const collector = createToolDeliverablesCollector(tools, existing);
  return createAgent({
    model: new CallingModel(tools.map((value, index) => ({ name: value.name, id: `call-${index}`, args: {} }))),
    tools: enabled ? collector.tools : tools,
    middleware: enabled ? [collector.middleware, ...collector.toolMiddleware] : existing,
  });
}

function toolResults(result: { messages: BaseMessage[] }) {
  return result.messages.filter(ToolMessage.isInstance).map(message => ({
    content: message.content, artifact: message.artifact, status: message.status,
    name: message.name, tool_call_id: message.tool_call_id,
  }));
}

const passThrough = () => createMiddleware({ name: 'ExistingToolWrapper', wrapToolCall: (request, handler) => handler(request) });

test('adapted tools retain their provider function schema and returnDirect metadata', () => {
  const source = tool(({ path }) => `Published ${path}.`, {
    name: 'publish_report', description: 'Publish a report from the selected path.',
    schema: z.object({ path: z.string().describe('Report file path.'), title: z.string().optional() }),
    returnDirect: true,
  });
  const adapted = createToolDeliverablesCollector([source], []).tools[0];
  const definition = convertToOpenAITool(adapted);
  assert.deepEqual(definition, convertToOpenAITool(source));
  assert.equal(definition.function.name, source.name);
  assert.equal(definition.function.description, source.description);
  assert.strictEqual(adapted.schema, source.schema);
  assert.equal(adapted.returnDirect, true);
});

test('ordinary tool outputs and callbacks keep their behavior in both collection modes', async () => {
  for (const existing of [[], [passThrough()]]) {
    const runs = [];
    for (const enabled of [false, true]) {
      const events: string[] = [];
      const plain = tool(() => 'Ordinary result.', { name: 'plain', description: 'Read.', schema: z.object({}) });
      const metadata = tool(() => ['Metadata result.', { fileCount: 2 }], {
        name: 'metadata', description: 'Read metadata.', schema: z.object({}), responseFormat: 'content_and_artifact',
      });
      const output = await graphFor([plain, metadata], enabled, existing).invoke({ messages: [new HumanMessage('Read.')] }, {
        callbacks: [{ handleToolStart() { events.push('start'); }, handleToolEnd() { events.push('end'); } }],
      });
      if (enabled) { assertToolDeliverables(output); assert.deepEqual(output.deliverables, []); }
      runs.push({ tools: toolResults(output), events: events.sort() });
    }
    assert.deepEqual(runs[1], runs[0]);
    assert.deepEqual(runs[1].events, ['end', 'end', 'start', 'start']);
  }
});

test('collects middleware-contributed tools while retaining their state and hooks', async () => {
  for (const wrapped of [false, true]) {
    let executions = 0;
    let beforeCalls = 0;
    const contributed = tool(() => { executions++; return ['Contributed result.', declaration]; }, {
      name: 'contributed', description: 'Publish from middleware.', schema: z.object({}), responseFormat: 'content_and_artifact',
    });
    const contributor = createMiddleware({
      name: 'ContributedTools', tools: [contributed],
      stateSchema: new StateSchema({ marker: z4.string().default('kept') as never }),
      beforeModel: state => { beforeCalls++; assert.equal(state.marker, 'kept'); },
    });
    const collector = createToolDeliverablesCollector([], wrapped ? [contributor, passThrough()] : [contributor]);
    const agent = createAgent({
      model: new CallingModel([{ name: 'contributed', id: 'call-0', args: {} }]),
      tools: collector.tools, middleware: [collector.middleware, ...collector.toolMiddleware],
    });
    const output = await agent.invoke({ messages: [new HumanMessage('Publish.')] });
    assertToolDeliverables(output);
    assert.deepEqual(output.deliverables, declaration.deliverables);
    assert.equal(executions, 1);
    assert.equal(beforeCalls, 2);
    assert.equal(toolResults(output)[0].content, 'Contributed result.');
  }
});

test('returnDirect publishing tools collect their declaration without an additional model call', async () => {
  for (const existing of [[], [passThrough()]]) {
    const direct = tool(() => ['Direct result.', declaration], {
      name: 'direct', description: 'Publish and return.', schema: z.object({}),
      responseFormat: 'content_and_artifact', returnDirect: true,
    });
    const collector = createToolDeliverablesCollector([direct], existing);
    const model = new CallingModel([{ name: 'direct', id: 'call-0', args: {} }]);
    const output = await createAgent({
      model, tools: collector.tools, middleware: [collector.middleware, ...collector.toolMiddleware],
    }).invoke({ messages: [new HumanMessage('Publish.')] });
    assertToolDeliverables(output);
    assert.deepEqual(output.deliverables, declaration.deliverables);
    assert.equal(model.modelCalls, 1);
    assert.equal(output.messages.at(-1)?.text, 'Direct result.');
  }
});

test('ordinary tool failures retain default recovery and existing-wrapper propagation', async () => {
  const failure = new Error('Tool failed.');
  for (const enabled of [false, true]) {
    const failing = tool(() => { throw failure; }, { name: 'failing', description: 'Fail.', schema: z.object({}) });
    const output = await graphFor([failing], enabled).invoke({ messages: [new HumanMessage('Try.')] });
    assert.deepEqual(toolResults(output), [{
      content: 'Error: Tool failed.\n Please fix your mistakes.', artifact: undefined,
      status: 'error', name: 'failing', tool_call_id: 'call-0',
    }]);
    await assert.rejects(graphFor([failing], enabled, [passThrough()]).invoke({ messages: [new HumanMessage('Try.')] }),
      error => error === failure);
  }
});

test('tool argument errors remain recoverable with and without existing wrappers', async () => {
  for (const existing of [[], [passThrough()]]) {
    for (const enabled of [false, true]) {
      let executions = 0;
      const checked = tool(() => { executions++; return 'Unexpected.'; }, {
        name: 'checked', description: 'Requires a value.', schema: z.object({ value: z.string() }),
      });
      const output = await graphFor([checked], enabled, existing).invoke({ messages: [new HumanMessage('Try.')] });
      const results = toolResults(output);
      assert.equal(executions, 0);
      assert.equal(results.length, 1);
      assert.equal(results[0].status, 'error');
      assert.match(String(results[0].content), /Error invoking tool 'checked'/);
      assert.equal(output.messages.at(-1)?.text, 'Done.');
    }
  }
});

test('malformed declarations fail explicitly instead of silently disappearing', async () => {
  const malformed = tool(() => ['Malformed.', { deliverables: [{ uri: 1 }] }], {
    name: 'malformed', description: 'Return invalid metadata.', schema: z.object({}), responseFormat: 'content_and_artifact',
  });
  const output = await graphFor([malformed], true).invoke({ messages: [new HumanMessage('Try.')] });
  assertToolDeliverables(output);
  assert.deepEqual(output.deliverables, []);
  assert.equal(toolResults(output)[0].status, 'error');
  assert.match(String(toolResults(output)[0].content), /Invalid tool deliverable/);
  await assert.rejects(graphFor([malformed], true, [passThrough()]).invoke({ messages: [new HumanMessage('Try.')] }),
    /Invalid tool deliverable/);
});

test('tool interrupts and aborts retain their control flow in both collection modes', async () => {
  for (const existing of [[], [passThrough()]]) {
    for (const enabled of [false, true]) {
      let completed = 0;
      const paused = tool(() => {
        interrupt('Continue publishing?');
        completed++;
        return ['Published.', declaration];
      }, { name: 'paused', description: 'Pause then publish.', schema: z.object({}), responseFormat: 'content_and_artifact' });
      // createAgent compiles without a checkpointer unless one is supplied.
      const collector = createToolDeliverablesCollector([paused], existing);
      const saved = createAgent({
        model: new CallingModel([{ id: 'call-0', name: 'paused', args: {} }]),
        tools: enabled ? collector.tools : [paused],
        middleware: enabled ? [collector.middleware, ...collector.toolMiddleware] : existing,
        checkpointer: new MemorySaver(),
      });
      const config = { configurable: { thread_id: `interrupt-${enabled}-${existing.length}` } };
      const stopped = await saved.invoke({ messages: [new HumanMessage('Publish.')] }, config);
      assert.equal(completed, 0);
      assert.equal(stopped.__interrupt__?.[0].value, 'Continue publishing?');
      const resumed = await saved.invoke(new Command({ resume: true }), config);
      assert.equal(completed, 1);
      assert.equal(toolResults(resumed).length, 1);
      if (enabled) { assertToolDeliverables(resumed); assert.deepEqual(resumed.deliverables, declaration.deliverables); }

      const controller = new AbortController();
      const reason = new Error('Aborted publication.');
      const aborted = tool(() => { controller.abort(reason); throw reason; }, {
        name: 'aborted', description: 'Abort.', schema: z.object({}),
      });
      await assert.rejects(graphFor([aborted], enabled, existing).invoke({ messages: [new HumanMessage('Abort.')] }, { signal: controller.signal }),
        error => error === reason);
    }
  }
});

test('replaying a persisted declaration keeps one reference and its first title', async () => {
  const publish = tool(() => ['Published.', declaration], {
    name: 'publish', description: 'Publish.', schema: z.object({}), responseFormat: 'content_and_artifact',
  });
  const collector = createToolDeliverablesCollector([publish], []);
  const agent = createAgent({
    model: new CallingModel([{ name: 'publish', args: {}, id: 'call-0' }]),
    tools: collector.tools, middleware: [collector.middleware], checkpointer: new MemorySaver(),
  });
  const config = { configurable: { thread_id: 'replayed-declaration' } };
  await agent.invoke({ messages: [new HumanMessage('Publish.')] }, config);
  await agent.graph.updateState(config, { deliverables: declaration.deliverables });
  await agent.graph.updateState(config, { deliverables: [{ uri: declaration.deliverables[0].uri, title: 'Later title' }] });
  const checkpoint = await agent.graph.getState(config);
  assert.deepEqual(checkpoint.values.deliverables, declaration.deliverables);
});

test('collects overridden tools and synthetic results from an existing wrapper', async () => {
  let sourceCalls = 0;
  const source = tool(() => { sourceCalls++; return 'Original.'; }, { name: 'source', description: 'Read.', schema: z.object({}) });
  const replacement = tool(() => ['Replacement.', declaration], {
    name: 'source', description: 'Replacement.', schema: z.object({}), responseFormat: 'content_and_artifact',
  });
  for (const synthetic of [false, true]) {
    const existing = [createMiddleware({
      name: 'OverrideTool',
      wrapToolCall: (request, handler) => synthetic ? new ToolMessage({
        content: 'Synthetic.', artifact: declaration, name: request.toolCall.name, tool_call_id: request.toolCall.id!,
      }) : handler({ ...request, tool: replacement }),
    })];
    const output = await graphFor([source], true, existing).invoke({ messages: [new HumanMessage('Read.')] });
    assertToolDeliverables(output);
    assert.deepEqual(output.deliverables, declaration.deliverables);
    assert.equal(toolResults(output)[0].content, synthetic ? 'Synthetic.' : 'Replacement.');
  }
  assert.equal(sourceCalls, 0);
});

for (const tuple of [false, true]) {
  test(`same-graph Command ${tuple ? 'tuple' : 'object'} updates preserve control fields and metadata`, async () => {
    const message = new ToolMessage({ content: 'Published.', artifact: declaration, name: 'command', tool_call_id: 'call-0' });
    const original = new Command({ goto: '__end__', resume: { approved: true }, update: tuple
      ? [['messages', [message]], ['marker', 'preserved']] as [string, unknown][]
      : { messages: [message], marker: 'preserved' } });
    const command = tool(() => original, { name: 'command', description: 'Publish.', schema: z.object({}) });
    const collector = createToolDeliverablesCollector([command], []);
    const result = await collector.tools[0].invoke({ type: 'tool_call', name: 'command', id: 'call-0', args: {} });
    assert.ok(isCommand(result));
    assert.deepEqual(result.goto, original.goto);
    assert.deepEqual(result.resume, original.resume);
    assert.equal(result.graph, original.graph);
    const update = Object.fromEntries(Array.isArray(result.update) ? result.update : Object.entries(result.update ?? {}));
    assert.equal(update.marker, 'preserved');
    assert.strictEqual((update.messages as ToolMessage[])[0], message);
    assert.deepEqual(update.deliverables, declaration.deliverables);
  });
}

test('cross-graph Commands pass through unchanged instead of writing child state into another graph', async () => {
  const original = new Command({ graph: Command.PARENT, goto: 'continue', update: {
    messages: [new ToolMessage({ content: 'Transfer.', artifact: declaration, tool_call_id: 'call-0' })],
  } });
  const transfer = tool(() => original, { name: 'transfer', description: 'Transfer.', schema: z.object({}) });
  for (const existing of [[], [passThrough()]]) {
    const collector = createToolDeliverablesCollector([transfer], existing);
    const result = existing.length ? await collector.middleware.wrapToolCall!({
      toolCall: { name: 'transfer', args: {}, id: 'call-0' }, tool: transfer,
      state: { messages: [], deliverables: [] }, runtime: {},
    } as never, async () => original) : await collector.tools[0].invoke({ name: 'transfer', args: {}, id: 'call-0', type: 'tool_call' });
    assert.strictEqual(result, original);
    assert.equal('deliverables' in (original.update ?? {}), false);
  }
});
