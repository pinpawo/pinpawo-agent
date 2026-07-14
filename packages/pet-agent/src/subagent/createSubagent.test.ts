import assert from 'node:assert/strict';
import test from 'node:test';
import { AIMessage, HumanMessage, type BaseMessage } from '@langchain/core/messages';
import { BaseChatModel } from '@langchain/core/language_models/chat_models';
import type { RunnableConfig } from '@langchain/core/runnables';
import { FakeListChatModel } from '@langchain/core/utils/testing';
import { tool } from '@langchain/core/tools';
import { FakeToolCallingModel } from 'langchain';
import { z } from 'zod';
import {
  MessagesAnnotation,
  StateGraph,
  START,
  END,
} from '@langchain/langgraph';
import {
  createSubagent,
  SUBAGENT_GUARD_DECISION_EVENT,
  SUBAGENT_OPERATIONS_EVENT,
} from './createSubagent';
import { NamespacedProtocolToolEventReader } from './protocolToolEvents';
import type { SubagentToolLifecycleEvent } from '../types/subagent';
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

class FailingSummaryModel extends BaseChatModel {
  callCount = 0;

  _llmType() {
    return 'failing-summary';
  }

  async _generate(): Promise<never> {
    this.callCount += 1;
    throw new Error('summary service unavailable');
  }

  bindTools() {
    return this;
  }
}

/**
 * The production shape (#322 Phase 4): a parent graph node runs createSubagent
 * with the parent config passed through, and every run signal — tool
 * lifecycle, guard decision records, the per-delegation operations
 * announcement — surfaces on the ROOT `streamEvents(v3)` protocol stream.
 * There is no bridged `onToolEvent` anymore.
 */
test('createSubagent surfaces tool lifecycle, guard decisions and operations on the root stream', async () => {
  const readFile = tool(async ({ path }) => `contents:${path}`, {
    name: 'read_file',
    description: 'read a file',
    schema: z.object({ path: z.string() }),
  });

  const delegate = async (
    state: typeof MessagesAnnotation.State,
    config?: RunnableConfig,
  ) => {
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
      messages: state.messages,
      maxIterations: 4,
      runnableConfig: config,
    });
    return { messages: result.messages };
  };

  const graph = new StateGraph(MessagesAnnotation)
    .addNode('delegate', delegate)
    .addEdge(START, 'delegate')
    .addEdge('delegate', END)
    .compile();

  const run = await graph.streamEvents(
    { messages: [new HumanMessage('read the file')] },
    { version: 'v3' },
  );

  const reader = new NamespacedProtocolToolEventReader();
  const lifecycle: SubagentToolLifecycleEvent[] = [];
  const runtimeEvents: Array<{ name?: unknown; data?: unknown }> = [];
  for await (const event of run) {
    if (event.method === 'tools') {
      const toolEvent = reader.readToolsData(
        event.params.namespace as string[] | undefined,
        event.params.data,
      );
      if (toolEvent) {
        lifecycle.push(toolEvent);
      }
    }
    if (event.method === 'custom') {
      runtimeEvents.push(event.params.data as { name?: unknown; data?: unknown });
    }
  }
  await run.output;

  // Child tool lifecycle reached the root protocol stream with resolved names.
  const startAndEnd = lifecycle.filter(
    (event) => event.event === 'on_tool_start' || event.event === 'on_tool_end',
  );
  assert.deepEqual(startAndEnd.map((event) => event.event), ['on_tool_start', 'on_tool_end']);
  assert.equal(startAndEnd[0]?.name, 'read_file');
  assert.equal(startAndEnd[0]?.toolCallId, 'call-read');
  assert.equal(startAndEnd[1]?.name, 'read_file');
  assert.equal(startAndEnd[1]?.toolCallId, 'call-read');

  // Guard decision records ride the writer to the root custom channel.
  const guardRecords = runtimeEvents
    .filter((data) => data?.name === SUBAGENT_GUARD_DECISION_EVENT)
    .map((data) => data.data as GuardDecisionRecord)
    .filter((record) => record.guard === 'subagent_iteration_limit');
  assert.equal(guardRecords.length, 2);
  assert.deepEqual(guardRecords[0], {
    guard: 'subagent_iteration_limit',
    position: 'subagent.before_model_iteration',
    outcome: { kind: 'proceed' },
    iteration: 1,
  });

  // The per-delegation operations map is announced for display-metadata joins.
  const operationEvents = runtimeEvents.filter((data) => data?.name === SUBAGENT_OPERATIONS_EVENT);
  assert.equal(operationEvents.length, 1);
  const announced = (operationEvents[0]?.data as {
    operations?: Record<string, { title?: string }>;
  })?.operations;
  assert.equal(announced?.read_file?.title, 'Read File');
});

test('createSubagent summarizes persisted history from contextWindowTokens', async () => {
  const oldContext = `old investigation evidence\n${'x'.repeat(800)}`;
  const result = await createSubagent({
    model: new FakeListChatModel({
      responses: [
        'preserved summary with src/a.ts and the pending verification step',
        'subagent result',
      ],
      sleep: 0,
    }),
    tools: [],
    instructions: [],
    contextWindowTokens: 1000,
    messages: [
      new HumanMessage(oldContext),
      new AIMessage(`The next step is to verify src/a.ts.\n${'y'.repeat(800)}`),
      new HumanMessage(`Check the earlier implementation details.\n${'z'.repeat(800)}`),
      new AIMessage(`The verification step is still pending.\n${'w'.repeat(800)}`),
      new HumanMessage('Continue the delegated task.'),
    ],
    maxIterations: 4,
  });

  assert.equal(result.completionReason, 'natural');
  const summary = result.messages.find(
    (message) => message.additional_kwargs?.lc_source === 'summarization',
  );
  assert.ok(summary);
  assert.match(String(summary.content), /Earlier subagent context summary:/);
  assert.match(String(summary.content), /preserved summary with src\/a\.ts/);
  assert.equal(result.messages.some((message) => message.content === oldContext), false);
});

test('createSubagent throws instead of committing an error summary', async () => {
  const model = new FailingSummaryModel({});

  await assert.rejects(
    createSubagent({
      model,
      tools: [],
      instructions: [],
      contextWindowTokens: 1000,
      messages: [
        new HumanMessage(`old evidence\n${'x'.repeat(800)}`),
        new AIMessage(`pending verification\n${'y'.repeat(800)}`),
        new HumanMessage(`continue investigation\n${'z'.repeat(800)}`),
        new AIMessage(`more findings\n${'w'.repeat(800)}`),
        new HumanMessage('Finish the delegated task.'),
      ],
      maxIterations: 4,
    }),
    /Subagent context summarization failed: Error generating summary: Error: summary service unavailable/,
  );
  // The only model call was the failed summary; the main subagent model call
  // must not continue after an invalid state update.
  assert.equal(model.callCount, 1);
});

test('createSubagent throws when history cannot be trimmed into a summary', async () => {
  await assert.rejects(
    createSubagent({
      model: new FakeListChatModel({ responses: ['must not continue'], sleep: 0 }),
      tools: [],
      instructions: [],
      contextWindowTokens: 1000,
      messages: [
        new HumanMessage(`single oversized context\n${'x'.repeat(4_000)}`),
        new AIMessage('Continue.'),
        new HumanMessage('Finish the delegated task.'),
      ],
      maxIterations: 4,
    }),
    /Subagent context summarization failed: Previous conversation was too long to summarize/,
  );
});

test('createSubagent throws on an empty context summary', async () => {
  await assert.rejects(
    createSubagent({
      model: new FakeListChatModel({ responses: ['', 'must not continue'], sleep: 0 }),
      tools: [],
      instructions: [],
      contextWindowTokens: 1000,
      messages: [
        new HumanMessage(`old evidence\n${'x'.repeat(800)}`),
        new AIMessage(`pending verification\n${'y'.repeat(800)}`),
        new HumanMessage(`continue investigation\n${'z'.repeat(800)}`),
        new AIMessage(`more findings\n${'w'.repeat(800)}`),
        new HumanMessage('Finish the delegated task.'),
      ],
      maxIterations: 4,
    }),
    /Subagent context summarization failed: empty summary/,
  );
});

test('createSubagent leaves single-result sizing to the toolkit below the watermark', async () => {
  const readFile = tool(async () => 'x'.repeat(20_001), {
    name: 'read_file',
    description: 'read a large file',
    schema: z.object({ path: z.string() }),
  });
  const result = await createSubagent({
    model: new FakeToolCallingModel({
      toolCalls: [
        [{ id: 'call-large', name: 'read_file', args: { path: 'large.log' } }],
        [],
      ],
    }),
    tools: [readFile],
    instructions: [],
    messages: [new HumanMessage('read the file')],
    maxIterations: 4,
  });

  const toolResult = result.messages.find((message) => message._getType() === 'tool');
  assert.ok(toolResult);
  assert.equal(String(toolResult.content).length, 20_001);
});

test('createSubagent does not summarize history below the derived token trigger', async () => {
  const result = await createSubagent({
    model: new FakeListChatModel({ responses: ['done'], sleep: 0 }),
    tools: [],
    instructions: [],
    messages: [new HumanMessage('small delegated task context')],
    contextWindowTokens: 1000,
    maxIterations: 4,
  });

  assert.equal(
    result.messages.some((message) => message.additional_kwargs?.lc_source === 'summarization'),
    false,
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
