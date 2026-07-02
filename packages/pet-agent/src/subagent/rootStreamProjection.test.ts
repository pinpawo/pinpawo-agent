import assert from 'node:assert/strict';
import test from 'node:test';
import { AIMessage, HumanMessage, type BaseMessage } from '@langchain/core/messages';
import type { RunnableConfig } from '@langchain/core/runnables';
import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import {
  Command,
  getWriter,
  interrupt,
  MemorySaver,
  MessagesAnnotation,
  StateGraph,
  START,
  END,
} from '@langchain/langgraph';
import { createAgent, createMiddleware, FakeToolCallingModel } from 'langchain';

/**
 * Issue #322 Phase 1 spike: prove (or refute) that a subagent created
 * DYNAMICALLY inside a parent graph node — and only `invoke()`d with the
 * parent's runnable config passed through — surfaces its model tokens, tool
 * lifecycle, custom events, and interrupts on the ROOT graph's
 * `streamEvents(version: 'v3')` stream.
 *
 * This is the load-bearing assumption behind migrating off the manual
 * `createSubagent()` → `onToolEvent` bridge. If these tests hold, the child
 * no longer needs to consume its own `agent.streamEvents()` (the root cause
 * of the double-tracer bugs fixed symptomatically in #313/#316), and
 * local-agent can consume one native root stream.
 */

const echoTool = tool(async ({ text }) => `echo:${text}`, {
  name: 'echo',
  description: 'echo the input',
  schema: z.object({ text: z.string() }),
});

function buildDynamicChildAgent() {
  // Mirrors the production shape: the child is assembled at runtime with
  // per-delegation model/tools/middleware, not registered as a static
  // subgraph node.
  return createAgent({
    name: 'subagent:general',
    model: new FakeToolCallingModel({
      toolCalls: [
        [{ id: 'call-echo', name: 'echo', args: { text: 'hi' } }],
        [],
      ],
    }),
    tools: [echoTool],
  });
}

function buildParentGraph(childRunner: (
  messages: BaseMessage[],
  config: RunnableConfig | undefined,
) => Promise<BaseMessage[]>) {
  const delegate = async (
    state: typeof MessagesAnnotation.State,
    config?: RunnableConfig,
  ) => {
    const childMessages = await childRunner(state.messages, config);
    return {
      messages: [
        ...childMessages,
        new AIMessage(`delegated:${childMessages.length}`),
      ],
    };
  };

  return new StateGraph(MessagesAnnotation)
    .addNode('delegate', delegate)
    .addEdge(START, 'delegate')
    .addEdge('delegate', END);
}

test('root streamEvents(v3) surfaces a dynamic child agent invoked with config passthrough', async () => {
  const graph = buildParentGraph(async (messages, config) => {
    const child = buildDynamicChildAgent();
    // The crucial difference from today's createSubagent(): pass the parent
    // config through untouched instead of stripping callbacks/runId.
    const result = await child.invoke({ messages }, config);
    return result.messages as BaseMessage[];
  }).compile();

  const run = await graph.streamEvents(
    { messages: [new HumanMessage('do the task')] },
    { version: 'v3' },
  );

  // Assert on RAW protocol events: the ergonomic projections (run.messages
  // etc.) showed subscription-timing sensitivity during the spike, while the
  // protocol stream reliably carries every event with its namespace — the
  // Phase 2 adapter should build on the protocol stream (or pin down the
  // projection wiring first).
  const toolEvents: Array<{ event?: unknown; tool_name?: unknown }> = [];
  const messageStartNamespaces: string[][] = [];
  const subgraphPaths: string[][] = [];
  const collectProtocol = (async () => {
    for await (const event of run) {
      if (event.method === 'tools') {
        toolEvents.push(event.params.data as { event?: unknown; tool_name?: unknown });
      }
      if (
        event.method === 'messages'
        && (event.params.data as { event?: unknown })?.event === 'message-start'
      ) {
        messageStartNamespaces.push([...(event.params.namespace ?? [])] as string[]);
      }
    }
  })();
  const collectSubgraphs = (async () => {
    for await (const subgraph of run.subgraphs) {
      subgraphPaths.push([...subgraph.path]);
    }
  })();

  await Promise.all([collectProtocol, collectSubgraphs]);
  const output = await run.output;

  // Child tool lifecycle reached the root protocol stream.
  const toolNames = toolEvents.map((data) => data.tool_name).filter(Boolean);
  assert.ok(
    toolEvents.some((data) => data.event === 'tool-started')
    && toolEvents.some((data) => data.event === 'tool-finished'),
    `expected child tool-started/tool-finished on the root stream, got: ${JSON.stringify(toolEvents)}`,
  );
  assert.ok(toolNames.includes('echo'), `expected echo tool events, got: ${JSON.stringify(toolNames)}`);

  // The dynamically created child was discovered as a namespaced subgraph.
  assert.ok(
    subgraphPaths.length > 0,
    'expected the dynamic child agent to be discovered as a subgraph namespace on the root stream',
  );

  // Child model calls are observable at the root as namespaced message
  // lifecycles (two child model calls: tool call + final answer), at
  // namespace depth 2 (node task + model_request). Messages a node adds to
  // state surface at depth 1 — namespace depth is how a consumer attributes
  // "model token stream" vs "state message addition".
  const childModelStarts = messageStartNamespaces.filter((namespace) => namespace.length >= 2);
  assert.equal(
    childModelStarts.length,
    2,
    `expected two child model lifecycles at namespace depth 2, got: ${JSON.stringify(messageStartNamespaces)}`,
  );

  // The run completed cleanly with the parent node's patch applied.
  const finalMessages = (output as { messages: BaseMessage[] }).messages;
  assert.ok(String(finalMessages.at(-1)?.content).startsWith('delegated:'));
});

test('custom events dispatched inside the child reach the root protocol stream', async () => {
  const childMiddleware = createMiddleware({
    name: 'SpikeGuardDecisionProbe',
    wrapModelCall: async (request, handler) => {
      // Stand-in for a subagent guard decision record. Pregel injects the
      // stream writer with `config.writer ??=`, so a child invoked with the
      // parent config writes through the PARENT's writer — this is the
      // native path for guard decision records under root streaming.
      getWriter()?.({
        name: 'spike_guard_decision',
        data: {
          guard: 'subagent_iteration_limit',
          outcome: { kind: 'proceed' },
        },
      });
      return handler(request);
    },
  });

  const graph = buildParentGraph(async (messages, config) => {
    const child = createAgent({
      name: 'subagent:probe',
      model: new FakeToolCallingModel({ toolCalls: [[]] }),
      tools: [],
      middleware: [childMiddleware],
    });
    const result = await child.invoke({ messages }, config);
    return result.messages as BaseMessage[];
  }).compile();

  const run = await graph.streamEvents(
    { messages: [new HumanMessage('probe')] },
    { version: 'v3' },
  );

  const customEvents: Array<{ name?: unknown; data?: unknown }> = [];
  for await (const event of run) {
    if (event.method === 'custom') {
      customEvents.push(event.params as { name?: unknown; data?: unknown });
    }
  }
  await run.output;

  assert.ok(
    customEvents.length > 0,
    'expected a custom event written inside the child to surface on the root stream',
  );
});

test('a child-in-tool nesting (the #313 scenario) completes cleanly but loses inner token visibility', async () => {
  // Under the old model this shape leaked parent callbacks into the inner
  // child while both levels consumed their own streamEvents — the double
  // tracer sharing a runTreeMap ("No run to end"). Under root streaming
  // neither level consumes its own stream, so that class of bug cannot
  // occur, and this test proves the nested run completes cleanly.
  //
  // KNOWN LIMITATION (documented by the assertions below): an agent invoked
  // from inside a TOOL does not get its own namespace segment, and its model
  // message lifecycles do NOT surface on the root stream — only its state
  // chunks flow, flattened into the enclosing tool's namespace. One-level
  // node → subagent nesting (the production orchestrator shape) is fully
  // projected; tool-boundary nesting needs its own treatment if live inner
  // tokens ever matter. If a LangGraph upgrade starts surfacing the inner
  // lifecycles, the message-count assertion here will fail — revisit then.
  const innerTool = tool(async ({ question }, config) => {
    const inner = createAgent({
      name: 'subagent:inner',
      model: new FakeToolCallingModel({ toolCalls: [[]] }),
      tools: [],
    });
    const result = await inner.invoke(
      { messages: [new HumanMessage(question)] },
      config,
    );
    return `inner:${(result.messages as BaseMessage[]).length}`;
  }, {
    name: 'ask_inner',
    description: 'delegate to the inner agent',
    schema: z.object({ question: z.string() }),
  });

  const graph = buildParentGraph(async (messages, config) => {
    const outer = createAgent({
      name: 'subagent:outer',
      model: new FakeToolCallingModel({
        toolCalls: [
          [{ id: 'call-inner', name: 'ask_inner', args: { question: 'deep' } }],
          [],
        ],
      }),
      tools: [innerTool],
    });
    const result = await outer.invoke({ messages }, config);
    return result.messages as BaseMessage[];
  }).compile();

  const run = await graph.streamEvents(
    { messages: [new HumanMessage('go deep')] },
    { version: 'v3' },
  );

  const namespaces: string[][] = [];
  const collectSubgraphs = (async () => {
    for await (const subgraph of run.subgraphs) {
      namespaces.push([...subgraph.path]);
    }
  })();
  let namespacedMessageStartCount = 0;
  const collectProtocol = (async () => {
    for await (const event of run) {
      if (
        event.method === 'messages'
        && (event.params.data as { event?: unknown })?.event === 'message-start'
        && (event.params.namespace ?? []).length >= 2
      ) {
        namespacedMessageStartCount += 1;
      }
    }
  })();

  await Promise.all([collectSubgraphs, collectProtocol]);
  const output = await run.output as { messages: BaseMessage[] };

  // The nested run completed cleanly — no closed-controller/tracer errors —
  // and the inner result flowed back through the outer child.
  assert.ok(
    output.messages.some((message) => String(message.content).startsWith('inner:')),
    'expected the inner child result to flow back through the outer child',
  );
  // Only the node-level child is discovered as a namespace.
  assert.equal(namespaces.length, 1, `got namespaces: ${JSON.stringify(namespaces)}`);
  // Only the outer child's two model calls surface as message lifecycles;
  // the inner child's model call is invisible through the tool boundary.
  assert.equal(namespacedMessageStartCount, 2);
});

test('an interrupt raised inside the dynamic child bubbles to root and resumes', async () => {
  const reviewTool = tool(async ({ action }) => {
    const decision = interrupt({ kind: 'review', action });
    return `approved:${String(decision)}:${action}`;
  }, {
    name: 'guarded_action',
    description: 'an action requiring human review',
    schema: z.object({ action: z.string() }),
  });

  const graph = buildParentGraph(async (messages, config) => {
    const child = createAgent({
      name: 'subagent:reviewed',
      model: new FakeToolCallingModel({
        toolCalls: [
          [{ id: 'call-review', name: 'guarded_action', args: { action: 'rm -rf' } }],
          [],
        ],
      }),
      tools: [reviewTool],
    });
    const result = await child.invoke({ messages }, config);
    return result.messages as BaseMessage[];
  }).compile({ checkpointer: new MemorySaver() });

  const config = { configurable: { thread_id: 'spike-review-1' } };

  const firstRun = await graph.streamEvents(
    { messages: [new HumanMessage('do the risky thing')] },
    { version: 'v3', ...config },
  );
  for await (const _event of firstRun) {
    // drain
  }
  await firstRun.output;
  const interrupts = firstRun.interrupts;
  assert.ok(
    interrupts.length > 0,
    'expected the child tool interrupt to surface on the root stream',
  );

  const resumedRun = await graph.streamEvents(
    new Command({ resume: 'yes' }),
    { version: 'v3', ...config },
  );
  for await (const _event of resumedRun) {
    // drain
  }
  const resumedOutput = await resumedRun.output as { messages: BaseMessage[] };
  const toolResult = resumedOutput.messages.find(
    (message) => String(message.content).startsWith('approved:'),
  );
  assert.ok(
    toolResult,
    `expected the resumed run to complete the reviewed tool call, got: ${resumedOutput.messages.map((m) => String(m.content)).join(' | ')}`,
  );
});
