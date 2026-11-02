import assert from 'node:assert/strict';
import test from 'node:test';
import { createToolDeliverables } from '@pinpawo/agent-contracts';
import { AIMessage, HumanMessage, ToolMessage, type BaseMessage } from '@langchain/core/messages';
import { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { tool, type ToolRuntime } from '@langchain/core/tools';
import { Annotation, Command, END, MemorySaver, MessagesAnnotation, ReducedValue, START, StateGraph, StateSchema, interrupt } from '@langchain/langgraph';
import { createMiddleware } from 'langchain';
import { z as z4 } from 'zod/v4';
import { buildReviewSpec } from '../types/reviewSpec';
import { z } from 'zod';
import { createSubagent } from './createSubagent';

class CompressingPublicationModel extends BaseChatModel {
  modelTurns = 0;
  summaries = 0;
  _llmType() { return 'collector-compaction-fixture'; }
  bindTools() { return this.withConfig({ stop: ['bound-tool-model'] }); }
  async _generate(_messages: BaseMessage[], options: this['ParsedCallOptions']) {
    if (!options.stop?.includes('bound-tool-model')) {
      this.summaries++;
      const message = new AIMessage('Earlier investigation summarized.');
      return { generations: [{ message, text: message.text }] };
    }
    const message = this.modelTurns++ === 0
      ? new AIMessage({ content: '', tool_calls: [{ id: 'published-report', name: 'publish_report', args: {} }] })
      : this.modelTurns === 2
        ? new AIMessage({ content: '', tool_calls: [{ id: 'later-evidence', name: 'investigate', args: {} }] })
        : new AIMessage('The investigation is complete.');
    return { generations: [{ message, text: message.text }] };
  }
}

test('one invocation retains collected references after summarization removes their tool messages', async () => {
  const report = { uri: 'artifact://workspace/report', title: 'Report' };
  let publications = 0;
  const publish = tool(() => {
    publications++;
    return [`Report evidence.\n${'x'.repeat(1200)}`, createToolDeliverables([report])];
  }, { name: 'publish_report', description: 'Publish the report.', schema: z.object({}), responseFormat: 'content_and_artifact' });
  const investigate = tool(() => `Later evidence.\n${'y'.repeat(1200)}`, {
    name: 'investigate', description: 'Inspect later evidence.', schema: z.object({}),
  });
  const model = new CompressingPublicationModel({});
  const result = await createSubagent({
    model, tools: [publish, investigate], promptSections: [], contextWindowTokens: 1000,
    messages: [new HumanMessage('Publish the report, then investigate later evidence.')],
  });
  assert.ok(model.summaries > 0);
  assert.ok(result.messages.some(message => message.additional_kwargs?.lc_source === 'summarization'));
  assert.equal(result.messages.some(message => ToolMessage.isInstance(message)
    && message.tool_call_id === 'published-report'), false);
  assert.deepEqual(result.deliverables, [report]);
  assert.equal(publications, 1);
  assert.equal(result.output, 'The investigation is complete.');
});

test('parallel tool results merge distinct references and deduplicate a shared URI', { timeout: 10_000 }, async () => {
  const calls: string[] = [];
  let release!: () => void;
  const together = new Promise<void>(resolve => { release = resolve; });
  const publish = tool(async ({ name }) => {
    calls.push(name);
    if (calls.length === 2) release();
    await together;
    return [`Published ${name}.`, createToolDeliverables([
      { uri: 'artifact://workspace/shared' }, { uri: `artifact://workspace/${name}` },
    ])];
  }, { name: 'publish', description: 'Publish one report.', schema: z.object({ name: z.string() }), responseFormat: 'content_and_artifact' });
  class ParallelPublicationModel extends BaseChatModel {
    _llmType() { return 'parallel-collector-fixture'; }
    bindTools() { return this; }
    async _generate(messages: BaseMessage[]) {
      const message = messages.some(ToolMessage.isInstance)
        ? new AIMessage('Both reports published.')
        : new AIMessage({ content: '', tool_calls: [
          { id: 'publish-A', name: 'publish', args: { name: 'A' } },
          { id: 'publish-B', name: 'publish', args: { name: 'B' } },
        ] });
      return { generations: [{ message, text: message.text }] };
    }
  }
  const result = await createSubagent({
    model: new ParallelPublicationModel({}), tools: [publish], promptSections: [],
    messages: [new HumanMessage('Publish A and B.')],
  });
  assert.deepEqual(calls.sort(), ['A', 'B']);
  assert.equal(result.deliverables.length, 3);
  assert.deepEqual(new Set(result.deliverables.map(reference => reference.uri)), new Set([
    'artifact://workspace/shared', 'artifact://workspace/A', 'artifact://workspace/B',
  ]));
  assert.equal(result.messages.filter(ToolMessage.isInstance).length, 2);
});

test('a completed parallel tool is not re-executed when its interrupted sibling resumes', async () => {
  const effects = { first: 0, reviewed: 0 };
  let reviewedAttempts = 0;
  let firstStarted!: () => void;
  const firstPublication = new Promise<void>(resolve => { firstStarted = resolve; });
  const shared = { uri: 'artifact://workspace/shared' };
  const first = { uri: 'artifact://workspace/first' };
  const reviewed = { uri: 'artifact://workspace/reviewed' };
  const publishFirst = tool(() => {
    effects.first++;
    firstStarted();
    return ['First publication.', createToolDeliverables([shared, first])];
  }, { name: 'publish_first', description: 'Publish the first report.', schema: z.object({}), responseFormat: 'content_and_artifact' });
  const publishReviewed = tool(async () => {
    reviewedAttempts++;
    await firstPublication;
    const approval = interrupt({
      kind: 'review',
      review: buildReviewSpec({ id: 'native-publication-review', view: { kind: 'plain', body: 'Publish this report?' },
        options: [{ id: 'approve', label: 'Approve', decision: { type: 'approve' } }],
      }),
      pendingAction: { actionId: 'publish-reviewed', toolName: 'publish_reviewed', args: {} },
    });
    assert.equal(approval, 'approve');
    effects.reviewed++;
    return ['Reviewed publication.', createToolDeliverables([shared, reviewed])];
  }, { name: 'publish_reviewed', description: 'Pause inside the tool before publishing.', schema: z.object({}), responseFormat: 'content_and_artifact' });
  class ParallelInterruptModel extends BaseChatModel {
    _llmType() { return 'parallel-interrupt-collector-fixture'; }
    bindTools() { return this; }
    async _generate(messages: BaseMessage[]) {
      const message = messages.filter(ToolMessage.isInstance).length === 2
        ? new AIMessage('Both publications complete.')
        : new AIMessage({ content: '', tool_calls: [
          { id: 'publish-first', name: 'publish_first', args: {} },
          { id: 'publish-reviewed', name: 'publish_reviewed', args: {} },
        ] });
      return { generations: [{ message, text: message.text }] };
    }
  }
  const ParentState = Annotation.Root({
    ...MessagesAnnotation.spec,
    deliverables: Annotation<typeof first[]>({ reducer: (_previous, next) => next, default: () => [] }),
  });
  const saver = new MemorySaver();
  const buildGraph = () => new StateGraph(ParentState).addNode('delegate', async (state, config) => {
    const result = await createSubagent({
      model: new ParallelInterruptModel({}), tools: [publishFirst, publishReviewed], promptSections: [],
      messages: state.messages, runnableConfig: config,
      runtimeContext: { executionScope: { threadId: 'parallel-review', runId: 'run', taskId: 'task', delegationId: 'delegation' } },
    });
    return { messages: result.messages, deliverables: result.deliverables };
  }).addEdge(START, 'delegate').addEdge('delegate', END).compile({ checkpointer: saver });
  const options = { configurable: { thread_id: 'parallel-review' } };
  const graph = buildGraph();
  await graph.invoke({ messages: [new HumanMessage('Publish both reports.')] }, options);
  assert.ok((await graph.getState(options)).tasks.some(task => task.interrupts?.length));
  assert.deepEqual(effects, { first: 1, reviewed: 0 });
  let firstStored = false;
  for await (const saved of saver.list(options)) {
    const updates = [saved.checkpoint.channel_values.deliverables,
      ...(saved.pendingWrites ?? []).filter(([, channel]) => channel === 'deliverables').map(([, , value]) => value)];
    firstStored ||= updates.some(value => Array.isArray(value)
      && value.some(reference => reference && typeof reference === 'object' && 'uri' in reference && reference.uri === first.uri));
  }
  assert.equal(firstStored, true, 'the successful tool result is checkpointed while its sibling is interrupted');
  const output = await buildGraph().invoke(new Command({ resume: 'approve' }), options);
  assert.deepEqual(effects, { first: 1, reviewed: 1 });
  assert.equal(reviewedAttempts, 2, 'the interrupted tool re-enters while the completed sibling remains cached');
  assert.equal(output.deliverables.length, 3);
  assert.deepEqual(new Set(output.deliverables.map(reference => reference.uri)), new Set([shared.uri, first.uri, reviewed.uri]));
  assert.equal(output.messages.filter(ToolMessage.isInstance).length, 2);
});

test('same-graph Command results preserve messages, control flow and unrelated state while collecting references', async () => {
  const report = { uri: 'artifact://workspace/command-report', title: 'Command report' };
  let observedMarker: string | undefined;
  const markerState = createMiddleware({
    name: 'CommandMarkerState',
    stateSchema: new StateSchema({ marker: new ReducedValue<string, string>(z4.string().default('unset') as never, {
      inputSchema: z4.string().default('unset') as never, reducer: (_previous, next) => next,
    }) }),
    afterAgent: (state) => { observedMarker = state.marker; },
  });
  const publish = tool((_args, runtime: ToolRuntime) => new Command({
    update: {
      messages: [new ToolMessage({ name: 'publish_command', tool_call_id: runtime.toolCallId,
        content: 'Command publication.', artifact: createToolDeliverables([report]) })],
      marker: 'preserved',
    },
    goto: 'model',
  }), { name: 'publish_command', description: 'Publish through a same-graph Command.', schema: z.object({}) });
  class CommandPublicationModel extends BaseChatModel {
    _llmType() { return 'command-collector-fixture'; }
    bindTools() { return this; }
    async _generate(messages: BaseMessage[]) {
      const message = messages.some(ToolMessage.isInstance)
        ? new AIMessage('Command publication complete.')
        : new AIMessage({ content: '', tool_calls: [{ id: 'command-publication', name: 'publish_command', args: {} }] });
      return { generations: [{ message, text: message.text }] };
    }
  }
  const result = await createSubagent({
    model: new CommandPublicationModel({}), tools: [publish], middleware: [markerState], promptSections: [],
    messages: [new HumanMessage('Publish the report.')],
  });
  assert.equal(observedMarker, 'preserved');
  assert.equal(result.output, 'Command publication complete.');
  assert.deepEqual(result.deliverables, [report]);
  const message = result.messages.find((value): value is ToolMessage => ToolMessage.isInstance(value)
    && value.tool_call_id === 'command-publication');
  assert.ok(message);
  assert.equal(message.content, 'Command publication.');
  assert.deepEqual(message.artifact, createToolDeliverables([report]));
});
