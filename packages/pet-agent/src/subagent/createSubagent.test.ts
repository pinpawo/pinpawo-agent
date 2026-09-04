import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { AIMessage, HumanMessage, type BaseMessage } from '@langchain/core/messages';
import { BaseChatModel } from '@langchain/core/language_models/chat_models';
import type { RunnableConfig } from '@langchain/core/runnables';
import { FakeListChatModel } from '@langchain/core/utils/testing';
import { tool, type ToolRuntime } from '@langchain/core/tools';
import { createMiddleware, FakeToolCallingModel } from 'langchain';
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
  SUBAGENT_PROMPT_SECTIONS_EVENT,
} from './createSubagent';
import { NamespacedProtocolToolEventReader } from './protocolToolEvents';
import type {
  SubagentRuntimeContext,
  SubagentToolLifecycleEvent,
} from '../types/subagent';
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

test('createSubagent rejects duplicate prompt section ids before invoking the model', async () => {
  await assert.rejects(
    createSubagent({
      model: new FakeListChatModel({ responses: ['unused'], sleep: 0 }),
      tools: [],
      promptSections: [
        { id: 'capability:test', content: 'First document.' },
        { id: 'capability:test', content: 'Duplicate document.' },
      ],
      messages: [new HumanMessage('test')],
    }),
    /Duplicate system prompt section id: capability:test/,
  );
});

test('createSubagent exposes invocation context to tool runtime', async () => {
  let seenExecutionScope: SubagentRuntimeContext['executionScope'];
  let seenToolkitRuntime: unknown;
  const inspectContext = tool(async (
    _input,
    runtime: ToolRuntime<unknown, SubagentRuntimeContext>,
  ) => {
    seenExecutionScope = runtime.context.executionScope;
    seenToolkitRuntime = runtime.context.toolkitRuntimes?.example;
    return 'context inspected';
  }, {
    name: 'inspect_context',
    description: 'Inspect the subagent runtime context.',
    schema: z.object({}),
  });

  await createSubagent({
    model: new FakeToolCallingModel({
      toolCalls: [
        [{
          id: 'call-inspect-context',
          name: 'inspect_context',
          args: {},
        }],
        [],
      ],
    }),
    tools: [inspectContext],
    promptSections: [],
    messages: [new HumanMessage('Inspect the context.')],
    runtimeContext: {
      executionScope: {
        threadId: 'thread-1',
        runId: 'run-1',
        delegationId: 'delegation-1',
        workdir: '/workspace',
      },
      toolkitRuntimes: {
        example: 'runtime-port',
      },
    },
  });

  assert.deepEqual(seenExecutionScope, {
    threadId: 'thread-1',
    runId: 'run-1',
    delegationId: 'delegation-1',
    workdir: '/workspace',
  });
  assert.equal(seenToolkitRuntime, 'runtime-port');
});

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
      promptSections: [{
        id: 'capability:read',
        owner: 'read',
        content: 'Read the requested file.',
      }],
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

  const promptEvents = runtimeEvents.filter(
    (data) => data?.name === SUBAGENT_PROMPT_SECTIONS_EVENT,
  );
  assert.equal(promptEvents.length, 1);
  assert.deepEqual(
    (promptEvents[0]?.data as {
      sections?: Array<{ id: string; owner: string | null; digest: string }>;
    }).sections?.map(({ id, owner, digest }) => ({
      id,
      owner,
      digestLength: digest.length,
    })),
    [
      { id: 'framework:governing', owner: 'framework', digestLength: 64 },
      { id: 'capability:read', owner: 'read', digestLength: 64 },
    ],
  );
  const capabilitySection = (promptEvents[0]?.data as {
    sections?: Array<{ id: string; digest: string }>;
  }).sections?.find(({ id }) => id === 'capability:read');
  assert.equal(
    capabilitySection?.digest,
    createHash('sha256').update('Read the requested file.', 'utf8').digest('hex'),
  );
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
    promptSections: [],
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
  assert.equal(result.announceMessageId, result.messages.at(-1)?.id);
  const summary = result.messages.find(
    (message) => message.additional_kwargs?.lc_source === 'summarization',
  );
  assert.ok(summary);
  assert.match(String(summary.content), /Earlier subagent context summary:/);
  assert.match(String(summary.content), /preserved summary with src\/a\.ts/);
  assert.equal(result.messages.some((message) => message.content === oldContext), false);
});

test('context summarization renders image payloads through LangChain text projection', async () => {
  const imageData = 'A'.repeat(4000);
  const summarizerInputs: string[] = [];
  class RecordingSummaryModel extends FakeListChatModel {
    override async _generate(messages: never, options: never, runManager: never) {
      summarizerInputs.push(JSON.stringify(messages));
      return super._generate(messages, options, runManager);
    }
  }
  const screenshot = new HumanMessage({
    content: [
      { type: 'text', text: 'Browser screenshot from the preceding tool result.' },
      { type: 'image', mimeType: 'image/png', data: imageData },
    ],
    response_metadata: { output_version: 'v1' },
  });

  const result = await createSubagent({
    model: new RecordingSummaryModel({
      responses: ['summary of the earlier investigation', 'subagent result'],
      sleep: 0,
    }),
    tools: [],
    promptSections: [],
    contextWindowTokens: 1000,
    messages: [
      new HumanMessage(`old investigation evidence\n${'x'.repeat(1200)}`),
      new AIMessage(`Looking at the page.\n${'y'.repeat(1200)}`),
      screenshot,
      new AIMessage(`The layout is broken.\n${'w'.repeat(1200)}`),
      new HumanMessage('Continue the delegated task.'),
    ],
    maxIterations: 4,
  });

  assert.equal(result.completionReason, 'natural');
  assert.ok(
    result.messages.some(
      (message) => message.additional_kwargs?.lc_source === 'summarization',
    ),
    'expected summarization to run',
  );
  // LangChain's built-in summarizer renders image blocks as `[image]` without
  // changing messages that survive its keep cutoff.
  assert.ok(summarizerInputs.length > 0);
  for (const input of summarizerInputs) {
    assert.doesNotMatch(input, /A{100}/);
  }
  assert.ok(
    summarizerInputs.some((input) => input.includes('[image]')),
    'expected LangChain to represent the image as a text placeholder',
  );
  assert.doesNotMatch(
    JSON.stringify(result.messages),
    /A{100}/,
    'expected the summarized image message to be folded into the summary',
  );
});

test('summarization preserves the real image when it keeps the message', async () => {
  const imageData = 'B'.repeat(4000);
  const screenshot = new HumanMessage({
    content: [
      { type: 'text', text: 'Browser screenshot from the preceding tool result.' },
      { type: 'image', mimeType: 'image/png', data: imageData },
    ],
    response_metadata: { output_version: 'v1' },
  });

  const result = await createSubagent({
    model: new FakeListChatModel({
      responses: ['summary of the earlier investigation', 'subagent result'],
      sleep: 0,
    }),
    tools: [],
    promptSections: [],
    contextWindowTokens: 1000,
    messages: [
      new HumanMessage(`old investigation evidence\n${'x'.repeat(1600)}`),
      new AIMessage(`Older reasoning.\n${'y'.repeat(1600)}`),
      new HumanMessage('Continue the delegated task.'),
      screenshot,
    ],
    maxIterations: 4,
  });

  assert.equal(result.completionReason, 'natural');
  assert.ok(
    result.messages.some(
      (message) => message.additional_kwargs?.lc_source === 'summarization',
    ),
    'expected summarization to run',
  );
  // A screenshot recent enough to survive the cutoff comes back unchanged from
  // LangChain's built-in summarization middleware.
  assert.match(JSON.stringify(result.messages), /B{100}/);
});

test('createSubagent throws instead of committing an error summary', async () => {
  const model = new FailingSummaryModel({});

  await assert.rejects(
    createSubagent({
      model,
      tools: [],
      promptSections: [],
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
      promptSections: [],
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
      promptSections: [],
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
      promptSections: [],
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
    promptSections: [],
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
    promptSections: [],
    messages: [new HumanMessage('do the task'), staleStopNotice, new HumanMessage('继续')],
    maxIterations: 4,
  });

  assert.equal(result.completionReason, 'natural');
  assert.equal(result.announceMessageId, result.messages.at(-1)?.id);
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
  const progress = new AIMessage({
    id: 'limit-progress',
    content: '已完成前置检查，后续工具步骤仍未完成。',
  });
  let progressInjected = false;
  const progressMiddleware = createMiddleware({
    name: 'LimitProgressProbe',
    beforeModel: () => {
      if (progressInjected) return;
      progressInjected = true;
      return { messages: [progress] };
    },
  });

  const result = await createSubagent({
    model: model as unknown as BaseChatModel,
    tools: [noop],
    middleware: [progressMiddleware],
    promptSections: [],
    messages: [new HumanMessage('go')],
    // no maxIterations -> default budget
  });

  assert.equal(result.completionReason, 'limit_reached');
  assert.equal(result.announceMessageId, progress.id);
  assert.ok(
    model.callCount > 20,
    `expected the raised default budget to allow many model calls, got ${model.callCount}`,
  );
});

test('createSubagent reports no announce when a limited run has no AI text deliverable', async () => {
  const noop = tool(async () => 'x', {
    name: 'noop',
    description: 'no-op',
    schema: z.object({}),
  });

  const result = await createSubagent({
    model: new NeverConvergingModel({}) as unknown as BaseChatModel,
    tools: [noop],
    promptSections: [],
    messages: [
      new HumanMessage('go'),
      new AIMessage('上一轮的交付不能充当本轮 announce。'),
      new HumanMessage('continue'),
    ],
    maxIterations: 1,
  });

  assert.equal(result.completionReason, 'limit_reached');
  assert.equal(result.announceMessageId, null);
});
