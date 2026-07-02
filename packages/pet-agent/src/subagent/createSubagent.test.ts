import assert from 'node:assert/strict';
import test from 'node:test';
import { AIMessage, HumanMessage, type BaseMessage } from '@langchain/core/messages';
import { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { FakeListChatModel } from '@langchain/core/utils/testing';
import { tool } from '@langchain/core/tools';
import { FakeToolCallingModel } from 'langchain';
import { z } from 'zod';
import { AsyncLocalStorageProviderSingleton } from '@langchain/core/singletons';
import {
  buildNestedSubagentStreamConfig,
  createSubagent,
  SUBAGENT_GUARD_DECISION_EVENT,
} from './createSubagent';
import type { GuardDecisionRecord } from '../guards';
import {
  SUBAGENT_GUARD_STOP_MARKER_KEY,
  readSubagentGuardStopReason,
} from './guardStop';

/**
 * Minimal model that never converges: it keeps emitting a fresh tool call every
 * turn, which exercises the subagent's graceful limit handling.
 */
class NeverConvergingModel extends BaseChatModel {
  callCount = 0;
  _llmType() {
    return 'never-converging';
  }
  async _generate() {
    this.callCount += 1;
    const message = new AIMessage({
      content: '',
      tool_calls: [{ id: `call-${this.callCount}`, name: 'noop', args: {} }],
    });
    return { generations: [{ message, text: '' }] };
  }
  bindTools() {
    return this;
  }
}

function usageMessage(content: string, inputTokens: number) {
  return new AIMessage({
    content,
    usage_metadata: {
      input_tokens: inputTokens,
      output_tokens: 10,
      total_tokens: inputTokens + 10,
    },
  });
}

test('buildNestedSubagentStreamConfig does not inherit parent callback run identity', () => {
  const callbacks = [{
    handleChainStart: async () => undefined,
  }];
  const config = buildNestedSubagentStreamConfig({
    callbacks,
    runId: 'parent-run',
    configurable: { thread_id: 'thread-1' },
    metadata: { source: 'parent' },
    tags: ['parent-tag'],
    maxConcurrency: 2,
  });

  assert.deepEqual(config, {
    configurable: { thread_id: 'thread-1' },
    metadata: { source: 'parent' },
    tags: ['parent-tag'],
    maxConcurrency: 2,
  });
});

test('createSubagent does not leak run events to AsyncLocalStorage-inherited parent callbacks', async () => {
  // Callbacks reach a nested run through AsyncLocalStorage even when the
  // explicit config is stripped. If they leak in, the nested pregel holds
  // duplicate tracer copies over one shared run map and every run-end fires
  // "No <type> run to end" (see the ALS isolation in createSubagent).
  const leaked: string[] = [];
  const parentCallbacks = [{
    handleChainStart: async () => {
      leaked.push('chain_start');
    },
    handleLLMStart: async () => {
      leaked.push('llm_start');
    },
    handleToolStart: async () => {
      leaked.push('tool_start');
    },
  }];
  const readFile = tool(async ({ path }) => `contents:${path}`, {
    name: 'read_file',
    description: 'read a file',
    schema: z.object({ path: z.string() }),
  });

  const result = await AsyncLocalStorageProviderSingleton.runWithConfig(
    { callbacks: parentCallbacks },
    () => createSubagent({
      model: new FakeToolCallingModel({
        toolCalls: [
          [{
            id: 'call-read',
            name: 'read_file',
            args: { path: 'README.md' },
          }],
          [],
        ],
      }),
      tools: [readFile],
      instructions: [],
      messages: [new HumanMessage('read the file')],
      maxIterations: 4,
    }),
  );

  assert.equal(result.completionReason, 'natural');
  assert.deepEqual(leaked, []);
});

test('createSubagent emits non-tool model text as runtime deltas', async () => {
  const events: unknown[] = [];

  const result = await createSubagent({
    model: new FakeListChatModel({
      responses: ['subagent result'],
      sleep: 0,
    }),
    tools: [],
    instructions: [],
    messages: [new HumanMessage('do the task')],
    maxIterations: 4,
    onToolEvent: (event) => {
      events.push(event);
    },
  });

  assert.equal(result.completionReason, 'natural');
  const deltas = events.filter((event): event is {
    event: 'on_runtime_event';
    name: 'subagent_message_delta';
    data: { text: string };
  } => Boolean(
    event
      && typeof event === 'object'
      && (event as { event?: unknown }).event === 'on_runtime_event'
      && (event as { name?: unknown }).name === 'subagent_message_delta',
  ));
  assert.equal(deltas.map((event) => event.data.text).join(''), 'subagent result');
});

test('createSubagent emits guard decision records as runtime events', async () => {
  const events: unknown[] = [];

  const result = await createSubagent({
    model: new FakeListChatModel({
      responses: ['subagent result'],
      sleep: 0,
    }),
    tools: [],
    instructions: [],
    messages: [new HumanMessage('do the task')],
    maxIterations: 4,
    onToolEvent: (event) => {
      events.push(event);
    },
  });

  assert.equal(result.completionReason, 'natural');
  const records = events
    .filter((event): event is { event: 'on_runtime_event'; name: string; data: GuardDecisionRecord } => Boolean(
      event
        && typeof event === 'object'
        && (event as { event?: unknown }).event === 'on_runtime_event'
        && (event as { name?: unknown }).name === SUBAGENT_GUARD_DECISION_EVENT,
    ))
    .map((event) => event.data);

  // One model call → one iteration-guard evaluation that proceeds.
  const iterationRecords = records.filter((record) => record.guard === 'subagent_iteration_limit');
  assert.equal(iterationRecords.length, 1);
  assert.deepEqual(iterationRecords[0], {
    guard: 'subagent_iteration_limit',
    position: 'subagent.before_model_iteration',
    outcome: { kind: 'proceed' },
    iteration: 1,
  });
});

test('createSubagent emits tool lifecycle events through event streaming', async () => {
  const events: unknown[] = [];
  const readFile = tool(async ({ path }) => `contents:${path}`, {
    name: 'read_file',
    description: 'read a file',
    schema: z.object({ path: z.string() }),
  });

  const result = await createSubagent({
    model: new FakeToolCallingModel({
      toolCalls: [
        [{
          id: 'call-read',
          name: 'read_file',
          args: { path: 'README.md' },
        }],
        [],
      ],
    }),
    tools: [readFile],
    instructions: [],
    operations: {
      read_file: {
        title: 'Read File',
      },
    },
    messages: [new HumanMessage('read the file')],
    maxIterations: 4,
    onToolEvent: (event) => {
      events.push(event);
    },
  });

  assert.equal(result.completionReason, 'natural');
  const toolEvents = events.filter((event): event is {
    event: 'on_tool_start' | 'on_tool_end';
    name: string;
    toolCallId?: string;
    operation?: { title?: string };
  } => Boolean(
    event
      && typeof event === 'object'
      && (
        (event as { event?: unknown }).event === 'on_tool_start'
        || (event as { event?: unknown }).event === 'on_tool_end'
      ),
  ));
  assert.deepEqual(toolEvents.map((event) => event.event), ['on_tool_start', 'on_tool_end']);
  assert.equal(toolEvents[0]?.name, 'read_file');
  assert.equal(toolEvents[0]?.toolCallId, 'call-read');
  assert.equal(toolEvents[0]?.operation?.title, 'Read File');
  assert.equal(toolEvents[1]?.name, 'read_file');
  assert.equal(toolEvents[1]?.toolCallId, 'call-read');
  assert.equal(toolEvents[1]?.operation?.title, 'Read File');
});

test('createSubagent preserves streamed tool progress from event streaming', async () => {
  const events: unknown[] = [];
  const search = tool(async function* ({ query }) {
    yield { message: `searching ${query}`, progress: 0.5 };
    return `done:${query}`;
  }, {
    name: 'search_docs',
    description: 'search docs',
    schema: z.object({ query: z.string() }),
  });

  await createSubagent({
    model: new FakeToolCallingModel({
      toolCalls: [
        [{
          id: 'call-search',
          name: 'search_docs',
          args: { query: 'streaming' },
        }],
        [],
      ],
    }),
    tools: [search],
    instructions: [],
    messages: [new HumanMessage('search docs')],
    maxIterations: 4,
    onToolEvent: (event) => {
      events.push(event);
    },
  });

  const progress = events.find((event): event is {
    event: 'on_tool_event';
    name: string;
    toolCallId?: string;
    data: unknown;
  } => Boolean(
    event
      && typeof event === 'object'
      && (event as { event?: unknown }).event === 'on_tool_event',
  ));
  assert.equal(progress?.name, 'search_docs');
  assert.equal(progress?.toolCallId, 'call-search');
  assert.equal(progress?.data, JSON.stringify({ message: 'searching streaming', progress: 0.5 }));
});

test('createSubagent contextPolicy rewrites persisted subagent transcript', async () => {
  const readFile = tool(async () => `file output\n${'x'.repeat(2600)}`, {
    name: 'view_file_chunk',
    description: 'read file chunk',
    schema: z.object({ path: z.string() }),
  });
  const result = await createSubagent({
    model: new FakeToolCallingModel({
      toolCalls: [
        [{
          id: 'call-read',
          name: 'view_file_chunk',
          args: { path: 'src/a.ts' },
        }],
        [],
      ],
    }),
    tools: [readFile],
    instructions: [],
    operations: {
      view_file_chunk: {
        summarizeInput: (input) => ({ target: (input as { path?: string }).path }),
      },
    },
    contextPolicy: {
      evictToolResults: {
        keepRecent: 0,
        minSizeChars: 2000,
      },
    },
    contextWindowTokens: 1000,
    messages: [
      new HumanMessage('read the file'),
      usageMessage('上一轮模型调用已经接近上下文触发线。', 900),
    ],
    maxIterations: 8,
  });

  assert.equal(result.completionReason, 'natural');
  const toolMessages = result.messages.filter((message) => message._getType() === 'tool');
  assert.equal(toolMessages.length, 1);
  assert.equal(toolMessages[0]?.content, '[evicted: view_file_chunk src/a.ts -> 已读；需要时重新调用]');
});

test('createSubagent custom context rewrite runs only after watermark guard blocks', async () => {
  const run = (inputTokens: number) => createSubagent({
    model: new FakeListChatModel({
      responses: ['subagent result'],
      sleep: 0,
    }),
    tools: [],
    instructions: [],
    contextPolicy: {
      rewrite: () => [new HumanMessage('custom rewritten context')],
    },
    messages: [
      new HumanMessage('do the task'),
      usageMessage('previous provider usage', inputTokens),
    ],
    contextWindowTokens: 1000,
    maxIterations: 4,
  });

  const belowWatermark = await run(400);
  assert.equal(
    belowWatermark.messages.some((message) => message.content === 'custom rewritten context'),
    false,
  );

  const aboveWatermark = await run(900);
  assert.equal(
    aboveWatermark.messages.some((message) => message.content === 'custom rewritten context'),
    true,
  );
});

test('createSubagent ignores a stop marker that arrives in the input history', async () => {
  // A stop marker buried in incoming history (not produced by this run) must not
  // be misread as our guard stop. The run completes naturally.
  const staleStopNotice = new AIMessage({
    content: '上一轮的停止说明',
    additional_kwargs: {
      pinpawo: {
        [SUBAGENT_GUARD_STOP_MARKER_KEY]: 'subagent_iteration_limit_reached',
      },
    },
  });

  const result = await createSubagent({
    model: new FakeListChatModel({ responses: ['fresh answer'], sleep: 0 }),
    tools: [],
    instructions: [],
    messages: [new HumanMessage('do the task'), staleStopNotice, new HumanMessage('继续')],
    maxIterations: 4,
  });

  assert.equal(result.completionReason, 'natural');
  // The final message is the fresh model answer, not the stale marker.
  assert.equal(readSubagentGuardStopReason(result.messages.at(-1) as BaseMessage), null);
});

test('createSubagent default iteration budget is a soft model-call guard', async () => {
  // A never-converging loop with no explicit maxIterations must run on the raised
  // default model-call budget, not the old small runtime breaker.
  const noop = tool(async () => 'x', {
    name: 'noop',
    description: 'no-op',
    schema: z.object({}),
  });
  const model = new NeverConvergingModel({});

  const result = await createSubagent({
    model: model as unknown as BaseChatModel,
    tools: [noop],
    instructions: [],
    messages: [new HumanMessage('go')],
    // no maxIterations -> default budget
  });

  assert.equal(result.completionReason, 'limit_reached');
  assert.ok(
    model.callCount > 20,
    `expected the raised default budget to allow many model calls, got ${model.callCount}`,
  );
});
