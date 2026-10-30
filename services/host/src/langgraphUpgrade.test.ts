import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AIMessage, AIMessageChunk, HumanMessage, type BaseMessage } from '@langchain/core/messages';
import { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { ChatGenerationChunk } from '@langchain/core/outputs';
import {
  Annotation, Command, DeltaChannel, END, START, StateGraph, interrupt, task, type StateSnapshot,
} from '@langchain/langgraph';
import { createAgent, createMiddleware } from 'langchain';
import { FileSaver } from './fileSaver';
import { adaptRootStream } from './events/rootStreamEventAdapter';

for (const durability of ['async', 'exit'] as const) {
  test(`FileSaver restores concurrent nested tasks once across partial resumes (${durability})`, async (t) => {
    const root = mkdtempSync(join(tmpdir(), 'pinpawo-upgrade-replay-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const path = join(root, 'checkpoints.json');
    const calls = { a: 0, b: 0, sibling: 0 };
    const effects = { a: 0, b: 0 };
    const State = Annotation.Root({
      items: Annotation<string[]>({ reducer: (left, right) => left.concat(right), default: () => [] }),
    });
    type Output = typeof State.State & { __interrupt__?: Array<{ id?: string; value: unknown }> };
    const buildGraph = () => {
      const child = (name: 'a' | 'b') => new StateGraph(State)
        .addNode('review', async () => {
          const policy = await task('policy', async () => { calls[name]++; return 'needs human'; })();
          const approved = interrupt({ name, policy });
          assert.equal(approved, true);
          effects[name]++;
          return { items: [name] };
        }).addEdge(START, 'review').addEdge('review', END).compile();
      const a = child('a');
      const b = child('b');
      return new StateGraph(State)
        .addNode('a', (_state, config) => a.invoke({ items: [] }, config))
        .addNode('b', (_state, config) => b.invoke({ items: [] }, config))
        .addNode('c', () => { calls.sibling++; return { items: ['c'] }; })
        .addEdge(START, 'a').addEdge(START, 'b').addEdge(START, 'c')
        .addEdge('a', END).addEdge('b', END).addEdge('c', END)
        .compile({ checkpointer: new FileSaver(path) });
    };
    const config = { configurable: { thread_id: 'parallel-nested' }, durability };
    let graph = buildGraph();
    const paused = await graph.invoke({ items: [] }, config) as Output;
    assert.equal(paused.__interrupt__?.length, 2);
    assert.deepEqual(calls, { a: 1, b: 1, sibling: 1 });
    const first = paused.__interrupt__!.find((item) => (item.value as { name: string }).name === 'a')!;
    assert.ok(first.id);
    graph = buildGraph();
    const head = await graph.getState(config);
    const partial = await graph.invoke(new Command({ resume: { [first.id]: true } }), {
      ...config, configurable: { ...config.configurable, checkpoint_id: head.config.configurable?.checkpoint_id },
    }) as Output;
    assert.equal(partial.__interrupt__?.length, 1);
    assert.deepEqual(effects, { a: 1, b: 0 });
    assert.deepEqual(calls, { a: 1, b: 1, sibling: 1 });
    graph = buildGraph();
    const second = partial.__interrupt__![0];
    assert.ok(second?.id);
    const done = await graph.invoke(new Command({ resume: { [second.id]: true } }), config) as Output;
    assert.equal(done.__interrupt__, undefined);
    assert.deepEqual(done.items, ['a', 'b', 'c']);
    assert.deepEqual(calls, { a: 1, b: 1, sibling: 1 });
    assert.deepEqual(effects, { a: 1, b: 1 });
    // Constructor GC must not drop writes needed to read the settled state.
    const restarted = new FileSaver(path);
    await restarted.collectThreadGarbage('parallel-nested');
    assert.deepEqual((await buildGraph().getState(config)).values.items, done.items);
  });
}

test('FileSaver refuses unsnapshotted DeltaChannels before latest-only pruning', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'pinpawo-upgrade-delta-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const saver = new FileSaver(join(root, 'checkpoints.json'));
  const State = Annotation.Root({
    items: new DeltaChannel<string[], string>((left, writes) => left.concat(writes)),
  });
  const graph = new StateGraph(State).addNode('add', () => ({ items: 'next' }))
    .addEdge(START, 'add').addEdge('add', END).compile({ checkpointer: saver });
  await assert.rejects(graph.invoke({ items: 'first' }, {
    configurable: { thread_id: 'delta' }, durability: 'sync',
  }), /latest-only retention cannot persist DeltaChannel/);
  await assert.rejects(saver.getDeltaChannelHistory({
    config: { configurable: { thread_id: 'delta' } }, channels: ['items'],
  }), /latest-only retention does not preserve ancestor writes/);
});

test('FileSaver restores DeltaChannels that snapshot every checkpoint', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'pinpawo-upgrade-delta-snapshot-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, 'checkpoints.json');
  const State = Annotation.Root({
    items: new DeltaChannel<string[], string>((left, writes) => left.concat(writes), { snapshotFrequency: 1 }),
  });
  const makeGraph = () => new StateGraph(State).addNode('add', () => ({ items: 'next' }))
    .addEdge(START, 'add').addEdge('add', END).compile({ checkpointer: new FileSaver(path) });
  const config = { configurable: { thread_id: 'snapshot-delta' } };
  const result = await makeGraph().invoke({ items: 'first' }, config);
  assert.deepEqual(result.items, ['first', 'next']);
  assert.deepEqual((await makeGraph().getState(config)).values.items, result.items);
});

test('snapshotFrequency 1 does not guarantee snapshots when only another channel changes', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'pinpawo-delta-quiet-step-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const State = Annotation.Root({
    items: new DeltaChannel<string[], string>((left, writes) => left.concat(writes), { snapshotFrequency: 1 }),
    status: Annotation<string>({ reducer: (_left, right) => right, default: () => '' }),
  });
  const graph = new StateGraph(State)
    .addNode('delta', () => ({ items: 'next' }))
    .addNode('ordinary', () => ({ status: 'done' }))
    .addEdge(START, 'delta').addEdge('delta', 'ordinary').addEdge('ordinary', END)
    .compile({ checkpointer: new FileSaver(join(root, 'checkpoints.json')) });
  await assert.rejects(graph.invoke({ items: 'first', status: '' }, {
    configurable: { thread_id: 'quiet-delta' }, durability: 'sync',
  }), /latest-only retention cannot persist DeltaChannel/);
});

for (const decision of ['reject', 'cancel'] as const) {
  test(`FileSaver retains a nested ${decision} without running the action or replaying policy`, async (t) => {
    const root = mkdtempSync(join(tmpdir(), 'pinpawo-saver-decline-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const path = join(root, 'checkpoints.json');
    const State = Annotation.Root({ result: Annotation<string>({ reducer: (_left, right) => right, default: () => '' }) });
    let policies = 0;
    let effects = 0;
    const build = () => {
      const child = new StateGraph(State).addNode('review', async () => {
        await task('policy', async () => { policies++; return 'review'; })();
        const answer = interrupt({ kind: 'review' });
        if (answer === 'approve') effects++;
        return { result: String(answer) };
      }).addEdge(START, 'review').addEdge('review', END).compile();
      return new StateGraph(State).addNode('child', (state, config) => child.invoke(state, config))
        .addEdge(START, 'child').addEdge('child', END)
        .compile({ checkpointer: new FileSaver(path) });
    };
    const config = { configurable: { thread_id: `decline-${decision}` } };
    const paused = await build().invoke({ result: '' }, config) as { __interrupt__?: Array<{ id?: string }> };
    const id = paused.__interrupt__?.[0]?.id;
    assert.ok(id);
    const completed = await build().invoke(new Command({ resume: { [id]: decision } }), config);
    assert.equal(completed.result, decision);
    assert.equal(policies, 1);
    assert.equal(effects, 0);
    assert.equal((await build().getState(config)).values.result, decision);
  });
}

for (const mode of ['invoke', 'streamEvents-v2', 'streamEvents-v3'] as const) {
  for (const decision of ['reject', 'edit'] as const) {
    test(`FileSaver retains normalized tool calls after ${mode}, ${decision}, and reload (#3038)`, async (t) => {
      const root = mkdtempSync(join(tmpdir(), 'pinpawo-upgrade-message-'));
      t.after(() => rmSync(root, { recursive: true, force: true }));
      const path = join(root, 'checkpoints.json');
      let modelCalls = 0;
      const observed: BaseMessage[][] = [];
      class StreamingModel extends BaseChatModel {
        _llmType() { return 'upgrade-stream-fixture'; }
        bindTools() { return this; }
        private response(messages: BaseMessage[]) {
          observed.push(messages);
          modelCalls++;
          if (modelCalls > 1) return new AIMessageChunk({ id: 'answer', content: 'done' });
          return new AIMessageChunk({
            id: 'action', content: '', additional_kwargs: { fixture_marker: 'preserved' },
            usage_metadata: { input_tokens: 3, output_tokens: 2, total_tokens: 5 },
            tool_call_chunks: [{ name: 'action_tool', args: '{"value":"original"}', id: 'call-1', index: 0 }],
          });
        }
        async _generate(messages: BaseMessage[]) {
          return { generations: [{ text: '', message: this.response(messages) }] };
        }
        async *_streamResponseChunks(messages: BaseMessage[]) {
          const response = this.response(messages);
          if (response.id !== 'action') {
            yield new ChatGenerationChunk({ text: 'done', message: response });
            return;
          }
          // One provider response split across text, reasoning and JSON-argument
          // deltas. These are accumulated by the real model callback path.
          const chunks = [
            new AIMessageChunk({ id: 'action', content: [{ type: 'reasoning', reasoning: 'private ', index: 0 }], additional_kwargs: { fixture_marker: 'preserved' } }),
            new AIMessageChunk({ id: 'action', content: [{ type: 'reasoning', reasoning: 'thought', index: 0 }] }),
            new AIMessageChunk({ id: 'action', content: [{ type: 'text', text: 'Visible ', index: 1 }],
              tool_call_chunks: [{ name: 'action_tool', args: '{"value":', id: 'call-1', index: 2 }] }),
            new AIMessageChunk({ id: 'action', content: [{ type: 'text', text: 'reply', index: 1 }],
              tool_call_chunks: [{ args: '"original"}', index: 2 }],
              usage_metadata: { input_tokens: 3, output_tokens: 2, total_tokens: 5 } }),
          ];
          for (const chunk of chunks) yield new ChatGenerationChunk({ text: '', message: chunk });
        }
      }
      const model = new StreamingModel({ outputVersion: 'v0' });
      const makeAgent = () => createAgent({ model, checkpointer: new FileSaver(path), middleware: [
        createMiddleware({ name: 'reviewFixture', afterModel: { canJumpTo: ['end'], hook: (state) => {
          const message = state.messages.at(-1);
          if (!AIMessage.isInstance(message) || message.id !== 'action') return;
          interrupt({ kind: 'review' });
          // This is the upstream bug's trigger: editing the parsed calls must
          // not be undone by raw chunk fields when the checkpoint reloads.
          // v3 also represents calls in canonical content blocks. Keep that
          // representation consistent when deleting a call; core 1.2.13 will
          // otherwise reconstruct it from content (a separate issue from raw
          // tool_call_chunks, with the same core version before this upgrade).
          if (decision === 'reject' && message.response_metadata.output_version === 'v1'
            && Array.isArray(message.content)) {
            message.content = message.content.filter((block) =>
              typeof block !== 'object' || block.type !== 'tool_call');
          }
          message.tool_calls = decision === 'reject' ? [] : [{
            id: 'call-1', name: 'action_tool', args: { value: 'edited' }, type: 'tool_call',
          }];
          return { messages: [message], jumpTo: 'end' as const };
        } } }),
      ] });
      const config = { configurable: { thread_id: `${mode}-${decision}` } };
      let agent = makeAgent();
      if (mode === 'invoke') await agent.invoke({ messages: [new HumanMessage('Do the action.')] }, config);
      else {
        if (mode === 'streamEvents-v3') {
          const stream = await agent.streamEvents({ messages: [new HumanMessage('Do the action.')] },
            { ...config, version: 'v3' });
          const publicText: string[] = [];
          for await (const event of adaptRootStream(stream, { isMainAssistantNode: () => true })) {
            if (event.type === 'assistant.delta') publicText.push(event.text);
          }
          assert.equal(publicText.join(''), 'Visible reply');
          assert.doesNotMatch(publicText.join(''), /private|thought/);
          await stream.output;
        } else {
          const stream = agent.streamEvents({ messages: [new HumanMessage('Do the action.')] },
            { ...config, version: 'v2' });
          for await (const _event of stream) { /* Enable core model streaming callbacks. */ }
        }
      }
      const saver = new FileSaver(path);
      const tuple = await saver.getTuple(config);
      const messages = tuple?.checkpoint.channel_values.messages as BaseMessage[];
      const action = messages.at(-1)!;
      assert.ok(AIMessage.isInstance(action));
      assert.equal(AIMessageChunk.isInstance(action), false);
      assert.equal('tool_call_chunks' in action, false);
      assert.deepEqual(action.tool_calls, [{ type: 'tool_call', id: 'call-1', name: 'action_tool', args: { value: 'original' } }]);
      if (mode !== 'invoke') {
        assert.match(JSON.stringify(action.content), /Visible reply/);
        assert.match(JSON.stringify(action.content), /private thought/);
      }
      // v3 projects model output through the standard protocol; v2/invoke
      // exercise the reducer's preservation of arbitrary additional fields.
      if (mode !== 'streamEvents-v3') assert.equal(action.additional_kwargs.fixture_marker, 'preserved');
      assert.equal(action.usage_metadata?.input_tokens, 3);
      assert.equal(action.usage_metadata?.output_tokens, 2);
      assert.equal(action.usage_metadata?.total_tokens, 5);
      assert.equal(tuple?.metadata?.counters_since_delta_snapshot, undefined,
        'the locked createAgent uses MessagesValue (a full-value ReducedValue), not MessagesDeltaValue');
      agent = makeAgent();
      const state = await agent.getState(config) as StateSnapshot;
      const pending = state.tasks.flatMap((item) => item.interrupts)[0];
      assert.ok(pending?.id);
      await agent.invoke(new Command({ resume: { [pending.id]: true } }), config);
      agent = makeAgent();
      const reloaded = ((await agent.getState(config)) as StateSnapshot).values.messages as BaseMessage[];
      const savedAction = reloaded.find((message) => message.id === 'action');
      assert.ok(AIMessage.isInstance(savedAction));
      const expected = decision === 'reject' ? [] : [{
        id: 'call-1', name: 'action_tool', args: { value: 'edited' }, type: 'tool_call',
      }];
      assert.deepEqual(savedAction.tool_calls, expected);
      assert.equal('tool_call_chunks' in savedAction, false);
      await agent.invoke({ messages: [new HumanMessage('Continue.')] }, config);
      const previousAction = observed.at(-1)?.find((message) => message.id === 'action');
      assert.ok(AIMessage.isInstance(previousAction));
      assert.deepEqual(previousAction.tool_calls, expected, 'next model input must retain the human edit');
      assert.equal(modelCalls, 2, 'resuming the review must not rerun the model');
    });
  }
}

test('legacy custom-model streaming keeps text and tool chunks with colliding indices',
  { todo: 'Upstream langchainjs#11074: legacy compat bridge conflates text and tool-call index 0; native ChatOpenAI uses separate events.' },
  async (t) => {
    const root = mkdtempSync(join(tmpdir(), 'pinpawo-compat-collision-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const path = join(root, 'checkpoints.json');
    class LegacyModel extends BaseChatModel {
      _llmType() { return 'compat-collision-fixture'; }
      bindTools() { return this; }
      async _generate(): Promise<never> { throw new Error('expected model streaming'); }
      async *_streamResponseChunks() {
        yield new ChatGenerationChunk({ text: 'Visible ', message: new AIMessageChunk({ id: 'action', content: 'Visible ' }) });
        yield new ChatGenerationChunk({ text: '', message: new AIMessageChunk({ id: 'action', content: '',
          tool_call_chunks: [{ id: 'call-1', name: 'action_tool', args: '{"value":"', index: 0 }] }) });
        yield new ChatGenerationChunk({ text: '', message: new AIMessageChunk({ id: 'action', content: '',
          tool_call_chunks: [{ args: 'original"}', index: 0 }] }) });
      }
    }
    const agent = createAgent({ model: new LegacyModel({}), checkpointer: new FileSaver(path), middleware: [
      createMiddleware({ name: 'compatReview', afterModel: { hook: () => { interrupt({ kind: 'review' }); } } }),
    ] });
    const config = { configurable: { thread_id: 'compat-collision' } };
    const stream = await agent.streamEvents({ messages: [new HumanMessage('Inspect.')] }, { ...config, version: 'v3' });
    for await (const _event of stream) { /* Consume real v3 callbacks. */ }
    await stream.output;
    const messages = (await new FileSaver(path).getTuple(config))?.checkpoint.channel_values.messages as BaseMessage[];
    const action = messages.find(message => message.id === 'action');
    assert.ok(AIMessage.isInstance(action));
    assert.deepEqual(action.tool_calls?.map(({ id, name, args }) => ({ id, name, args })),
      [{ id: 'call-1', name: 'action_tool', args: { value: 'original' } }]);
  });
