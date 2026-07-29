import assert from 'node:assert/strict';
import test from 'node:test';
import { AIMessage, HumanMessage, type BaseMessage } from '@langchain/core/messages';
import { FakeListChatModel } from '@langchain/core/utils/testing';
import type { RunnableConfig } from '@langchain/core/runnables';
import {
  MessagesAnnotation,
  StateGraph,
  START,
  END,
} from '@langchain/langgraph';
import { createSubagent, GUARD_DECISION_EVENT } from '@pinpawo/pet-agent';
import {
  adaptRootStream,
  readRootStreamChatEvent,
  readNamespaceNode,
  type RootProtocolEvent,
  type RootStreamAdapterState,
  type RootStreamChatEvent,
} from './rootStreamEventAdapter';

/**
 * Correspondence tests (#322 Phase 2): the adapter's output must express the
 * same semantics the legacy `graph.stream(['messages','values','custom'])`
 * consumption derives today —
 * - main assistant deltas only from non-internal root nodes;
 * - internal decision/discovery model output dropped;
 * - delegation-lane and deeper-namespace model output attributed to subagent;
 * - guard decision records surfaced from the custom channel;
 * - root values snapshots for final-message tracking.
 */

type WriterConfig = RunnableConfig & { writer?: (chunk: unknown) => void };

function streamingNode(model: FakeListChatModel) {
  return async (state: typeof MessagesAnnotation.State, config?: RunnableConfig) => {
    // Stream so the root 'messages' channel carries token deltas, matching
    // how production models surface in stream modes.
    const parts: string[] = [];
    const stream = await model.stream(state.messages, config);
    for await (const chunk of stream) {
      parts.push(String(chunk.content));
    }
    return { messages: [new AIMessage(parts.join(''))] };
  };
}

async function collectChatEvents(graph: {
  streamEvents: (input: unknown, options: unknown) => Promise<AsyncIterable<RootProtocolEvent>>;
}, messages: BaseMessage[] = [new HumanMessage('hi')]): Promise<RootStreamChatEvent[]> {
  const run = await graph.streamEvents(
    { messages },
    { version: 'v3' },
  );
  const events: RootStreamChatEvent[] = [];
  for await (const event of adaptRootStream(run)) {
    events.push(event);
  }
  return events;
}

test('adapter attributes root answer tokens to assistant and drops internal decision output', async () => {
  const graph = new StateGraph(MessagesAnnotation)
    .addNode('capabilityPlanner', streamingNode(new FakeListChatModel({ responses: ['route-thinking'], sleep: 0 })))
    .addNode('answer', streamingNode(new FakeListChatModel({ responses: ['你好，这是回复'], sleep: 0 })))
    .addEdge(START, 'capabilityPlanner')
    .addEdge('capabilityPlanner', 'answer')
    .addEdge('answer', END)
    .compile();

  const events = await collectChatEvents(graph as never);

  const assistantText = events
    .filter((event): event is Extract<RootStreamChatEvent, { type: 'assistant.delta' }> => event.type === 'assistant.delta')
    .map((event) => event.text)
    .join('');
  assert.equal(assistantText, '你好，这是回复');
  assert.ok(
    events
      .filter((event) => event.type === 'assistant.delta')
      .every((event) => event.type === 'assistant.delta' && event.node === 'answer'),
  );
  // Internal node output must not leak into any chat-visible event.
  assert.ok(!assistantText.includes('route-thinking'));
  assert.ok(
    events.every((event) => event.type !== 'subagent.message'
      || !event.text.includes('route-thinking')),
  );

  // Root values snapshots surface for final-message tracking.
  assert.ok(events.some((event) => event.type === 'values'
    && Array.isArray((event.values as { messages?: unknown }).messages)));
});

test('adapter drops synthetic assistant messages written by prepare', () => {
  const state: RootStreamAdapterState = new Map();
  const namespace = ['prepare:task-1'];
  const events = [
    readRootStreamChatEvent({
      type: 'event',
      seq: 1,
      method: 'messages',
      params: {
        namespace,
        data: { event: 'message-start', role: 'ai', id: 'briefing-1' },
      },
    }, state),
    readRootStreamChatEvent({
      type: 'event',
      seq: 2,
      method: 'messages',
      params: {
        namespace,
        data: {
          event: 'content-block-delta',
          delta: {
            type: 'text-delta',
            text: '<delegation_briefing mode="continue">',
          },
        },
      },
    }, state),
    readRootStreamChatEvent({
      type: 'event',
      seq: 3,
      method: 'messages',
      params: {
        namespace,
        data: { event: 'message-finish' },
      },
    }, state),
  ];

  assert.deepEqual(events, [null, null, null]);
});

test('adapter emits one completed subagent message per child lifecycle across multiple messages', async () => {
  // The P1-review scenario: a subagent emits several messages where a later
  // one extends earlier text ('foo' then 'foobar'). Lane-cumulative token
  // dedup would truncate the second message to 'bar'; per-lifecycle completed
  // messages must survive intact. Each child node also writes its message
  // back to child state (the same-namespace echo) and the lane node copies
  // child messages into parent state (the depth-1 lane echo) — neither may
  // duplicate or leak.
  const childGraph = new StateGraph(MessagesAnnotation)
    .addNode('act1', streamingNode(new FakeListChatModel({ responses: ['foo'], sleep: 0 })))
    .addNode('act2', streamingNode(new FakeListChatModel({ responses: ['foobar'], sleep: 0 })))
    .addEdge(START, 'act1')
    .addEdge('act1', 'act2')
    .addEdge('act2', END)
    .compile();

  const capability = async (state: typeof MessagesAnnotation.State, config?: RunnableConfig) => {
    const result = await childGraph.invoke({ messages: state.messages }, config);
    // Lane echo: copy the child's messages into parent state.
    return { messages: result.messages.slice(state.messages.length) };
  };

  const graph = new StateGraph(MessagesAnnotation)
    .addNode('capability', capability)
    .addNode('answer', streamingNode(new FakeListChatModel({ responses: ['主回复'], sleep: 0 })))
    .addEdge(START, 'capability')
    .addEdge('capability', 'answer')
    .addEdge('answer', END)
    .compile();

  const events = await collectChatEvents(graph as never);

  const subagentMessages = events
    .filter((event): event is Extract<RootStreamChatEvent, { type: 'subagent.message' }> => event.type === 'subagent.message')
    .map((event) => event.text);
  assert.deepEqual(subagentMessages, ['foo', 'foobar']);

  const assistantText = events
    .filter((event): event is Extract<RootStreamChatEvent, { type: 'assistant.delta' }> => event.type === 'assistant.delta')
    .map((event) => event.text)
    .join('');
  assert.ok(assistantText.includes('主回复'));
  assert.ok(!assistantText.includes('foo'), `assistant text leaked subagent output: ${JSON.stringify(assistantText)}`);
});

test('adapter hides context-summary model output and keeps the final subagent message', async () => {
  const summaryText = 'INTERNAL_SUMMARY_CONTENT';
  const finalText = 'FINAL_SUBAGENT_CONTENT';
  const capability = async (
    state: typeof MessagesAnnotation.State,
    config?: RunnableConfig,
  ) => {
    const result = await createSubagent({
      model: new FakeListChatModel({ responses: [summaryText, finalText], sleep: 0 }),
      tools: [],
      promptSections: [],
      messages: state.messages,
      contextWindowTokens: 1000,
      maxIterations: 4,
      runnableConfig: config,
    });
    const finalMessage = result.messages.at(-1);
    assert.ok(finalMessage);
    return { messages: [finalMessage] };
  };
  const graph = new StateGraph(MessagesAnnotation)
    .addNode('capability', capability)
    .addEdge(START, 'capability')
    .addEdge('capability', END)
    .compile();
  const messages = [
    new HumanMessage(`old evidence\n${'x'.repeat(800)}`),
    new AIMessage(`pending verification\n${'y'.repeat(800)}`),
    new HumanMessage(`continue investigation\n${'z'.repeat(800)}`),
    new AIMessage(`more findings\n${'w'.repeat(800)}`),
    new HumanMessage('Finish the delegated task.'),
  ];

  const events = await collectChatEvents(graph as never, messages);
  const subagentMessages = events
    .filter((event): event is Extract<RootStreamChatEvent, { type: 'subagent.message' }> => event.type === 'subagent.message')
    .map((event) => event.text);

  assert.deepEqual(subagentMessages, [finalText]);
  assert.ok(events.every((event) => event.type !== 'subagent.message'
    || !event.text.includes(summaryText)));
});

test('adapter surfaces guard decision records written to the stream writer', async () => {
  const guardNode = async (_state: typeof MessagesAnnotation.State, config?: WriterConfig) => {
    config?.writer?.({
      event: 'on_runtime_event',
      name: GUARD_DECISION_EVENT,
      data: {
        guard: 'run_iteration_limit',
        position: 'orchestrator.delegation_outcome_iteration',
        outcome: { kind: 'proceed' },
      },
    });
    return { messages: [new AIMessage('done')] };
  };

  const graph = new StateGraph(MessagesAnnotation)
    .addNode('guard', guardNode)
    .addEdge(START, 'guard')
    .addEdge('guard', END)
    .compile();

  const events = await collectChatEvents(graph as never);

  const decisions = events.filter(
    (event): event is Extract<RootStreamChatEvent, { type: 'guard.decision' }> => event.type === 'guard.decision',
  );
  assert.equal(decisions.length, 1);
  assert.equal(decisions[0]?.record.guard, 'run_iteration_limit');
  assert.deepEqual(decisions[0]?.record.outcome, { kind: 'proceed' });
});

test('readRootStreamChatEvent maps tool lifecycle and filters non-AI message deltas', () => {
  const state: RootStreamAdapterState = new Map();

  const toolEvent = readRootStreamChatEvent({
    type: 'event',
    seq: 1,
    method: 'tools',
    params: {
      namespace: ['general:t1', 'tools:t2'],
      data: { event: 'tool-started', tool_call_id: 'call-1', tool_name: 'read_file' },
    },
  }, state);
  assert.deepEqual(toolEvent, {
    type: 'tool',
    namespace: ['general:t1', 'tools:t2'],
    data: { event: 'tool-started', tool_call_id: 'call-1', tool_name: 'read_file' },
  });
  assert.equal(readRootStreamChatEvent({
    type: 'event',
    seq: 2,
    method: 'tools',
    params: {
      namespace: ['capabilityPlanner:t1', 'tools:t2'],
      data: {
        event: 'tool-started',
        tool_call_id: 'planner-call-1',
        tool_name: 'glob_search',
      },
    },
  }, state), null);

  // A human-role message's deltas are not assistant output.
  assert.equal(readRootStreamChatEvent({
    type: 'event',
    seq: 3,
    method: 'messages',
    params: { namespace: [], data: { event: 'message-start', role: 'human', id: 'm1' } },
  }, state), null);
  assert.equal(readRootStreamChatEvent({
    type: 'event',
    seq: 4,
    method: 'messages',
    params: { namespace: [], data: { event: 'content-block-delta', index: 0, delta: { type: 'text-delta', text: 'x' } } },
  }, state), null);

  // Interrupt surfaces from a root values snapshot, mirroring the legacy path.
  const interruptEvent = readRootStreamChatEvent({
    type: 'event',
    seq: 5,
    method: 'values',
    params: { namespace: [], data: { __interrupt__: [{ value: { kind: 'review' } }] } },
  }, state);
  assert.deepEqual(interruptEvent, {
    type: 'interrupt',
    interrupts: [{ value: { kind: 'review' } }],
  });

  assert.equal(readNamespaceNode(['answer:abc-123']), 'answer');
  assert.equal(readNamespaceNode([]), null);
});
