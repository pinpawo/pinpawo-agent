import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { AIMessage, HumanMessage, ToolMessage, type BaseMessage } from '@langchain/core/messages';
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

class ContextHandoffModel extends BaseChatModel {
  readonly inputs: BaseMessage[][] = [];
  readonly toolChoices: unknown[] = [];
  private toolChoice: unknown;

  constructor(private readonly response: string | Error = 'Partial progress; verification remains.') {
    super({});
  }

  _llmType() { return 'context-handoff-fixture'; }

  bindTools(_tools: unknown[], options?: Record<string, unknown>) {
    this.toolChoice = options?.tool_choice;
    return this;
  }

  async _generate(messages: BaseMessage[]) {
    this.inputs.push([...messages]);
    this.toolChoices.push(this.toolChoice);
    if (this.response instanceof Error) throw this.response;
    const message = new AIMessage(this.response);
    return { generations: [{ message, text: message.text }] };
  }
}

function contextHandoffNotice(messages: BaseMessage[]) {
  const notice = messages.find((message): message is ToolMessage => ToolMessage.isInstance(message)
    && message.name === 'runtime_budget_status');
  assert.ok(notice);
  const call = messages[messages.indexOf(notice) - 1];
  assert.ok(AIMessage.isInstance(call));
  assert.equal(call.tool_calls?.length, 1);
  assert.equal(call.tool_calls[0].id, notice.tool_call_id);
  const data = JSON.parse(notice.text);
  assert.equal(data.reason, 'context_window');
  assert.equal(data.phase, 'finalize');
  return notice;
}

test('subagent output preserves text spacing without exposing reasoning or tool blocks', async () => {
  class ContentModel extends BaseChatModel {
    _llmType() { return 'content-fixture'; }
    bindTools() { return this; }
    async _generate() {
      const message = new AIMessage({ content: [
        { type: 'thinking', thinking: 'private thought', signature: 'sig' },
        { type: 'tool_use', id: 'call-1', name: 'lookup', input: { text: 'private arguments' } },
        { type: 'text', text: ' public ' },
        { type: 'text', text: 'answer ' },
      ] });
      return { generations: [{ message, text: message.text }] };
    }
  }
  const result = await createSubagent({ model: new ContentModel({}), tools: [], promptSections: [],
    messages: [new HumanMessage('do the task')] });
  assert.equal(result.output, ' public answer ');
});

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
  const inspectContext = tool(async (
    _input,
    runtime: ToolRuntime<unknown, SubagentRuntimeContext>,
  ) => {
    seenExecutionScope = runtime.context.executionScope;
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
        taskId: 'task-1',
        runId: 'run-1',
        delegationId: 'delegation-1',
        workdir: '/workspace',
      },
    },
  });

  assert.deepEqual(seenExecutionScope, {
    threadId: 'thread-1',
    taskId: 'task-1',
    runId: 'run-1',
    delegationId: 'delegation-1',
    workdir: '/workspace',
  });
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

test('context watermark returns a handoff without summarizing or replacing persisted history', async () => {
  const model = new ContextHandoffModel();
  const history = [
    new HumanMessage({ id: 'old-evidence', content: 'x'.repeat(11_000) }),
    new AIMessage({ id: 'pending-work', content: 'y'.repeat(11_000) }),
    new HumanMessage({ id: 'more-evidence', content: 'z'.repeat(11_000) }),
    new AIMessage({ id: 'verification', content: 'w'.repeat(11_000) }),
    new HumanMessage({ id: 'continue', content: 'Continue the delegated task.' }),
  ];
  const noop = tool(() => 'must not execute', {
    name: 'noop', description: 'Inspect evidence.', schema: z.object({}),
  });
  const result = await createSubagent({
    model, tools: [noop], promptSections: [], messages: history,
    contextWindowTokens: 12_000, maxIterations: 20,
  });

  assert.equal(model.inputs.length, 1, 'the handoff does not require a separate summary call');
  assert.deepEqual(model.toolChoices, ['none']);
  assert.equal(result.output, 'Partial progress; verification remains.');
  assert.deepEqual(result.messages.slice(0, history.length).map(message => message.toDict()),
    history.map(message => message.toDict()));
  assert.ok(result.messages.every(message => message.additional_kwargs?.lc_source !== 'summarization'));
  const notice = contextHandoffNotice(result.messages);
  assert.ok(model.inputs[0].some(message => message.id === notice.id), 'the notice reaches the model after persistence');
  assert.equal(result.messages.filter(message => ToolMessage.isInstance(message)
    && message.name === 'runtime_budget_status').length, 1);
});

test('context handoff preserves original images in both the model input and checkpoint messages', async () => {
  const imageData = 'A'.repeat(4_000);
  const screenshot = new HumanMessage({
    id: 'screenshot',
    content: [
      { type: 'text', text: 'Browser screenshot from the preceding tool result.' },
      { type: 'image', mimeType: 'image/png', data: imageData },
    ],
    response_metadata: { output_version: 'v1' },
  });
  const model = new ContextHandoffModel();
  const result = await createSubagent({
    model, tools: [], promptSections: [], contextWindowTokens: 12_000,
    messages: [new HumanMessage('x'.repeat(44_000)), screenshot], maxIterations: 20,
  });

  assert.equal(model.inputs.length, 1);
  contextHandoffNotice(result.messages);
  assert.deepEqual(model.inputs[0].find(message => message.id === screenshot.id)?.content, screenshot.content);
  assert.deepEqual(result.messages.find(message => message.id === screenshot.id)?.content, screenshot.content);
  assert.ok(result.messages.every(message => message.additional_kwargs?.lc_source !== 'summarization'));
});

test('an oversized context stops locally without deleting history or fabricating a delivery', async () => {
  const model = new ContextHandoffModel();
  const oversized = new HumanMessage({ id: 'oversized', content: 'x'.repeat(56_000) });
  const result = await createSubagent({
    model, tools: [], promptSections: [], contextWindowTokens: 12_000,
    messages: [oversized], maxIterations: 20,
  });

  assert.equal(model.inputs.length, 0, 'a request already beyond usable input capacity must not reach the provider');
  assert.equal(result.output, null);
  assert.deepEqual(result.messages[0].toDict(), oversized.toDict());
  assert.equal(readSubagentGuardStopReason(result.messages.at(-1)!), 'subagent_context_limit_reached');
});

test('an empty context handoff remains missing rather than becoming a synthetic delivery', async () => {
  const model = new ContextHandoffModel('');
  const result = await createSubagent({
    model, tools: [], promptSections: [], contextWindowTokens: 12_000,
    messages: [new HumanMessage('x'.repeat(44_000))], maxIterations: 20,
  });

  assert.equal(model.inputs.length, 1);
  assert.equal(result.output, null);
  contextHandoffNotice(result.messages);
});

test('a failed context handoff propagates the model failure without rewriting history', async () => {
  const model = new ContextHandoffModel(new Error('model unavailable'));
  const history = [new HumanMessage({ id: 'evidence', content: 'x'.repeat(44_000) })];
  await assert.rejects(createSubagent({
    model, tools: [], promptSections: [], contextWindowTokens: 12_000,
    messages: history, maxIterations: 20,
  }), /model unavailable/);

  assert.equal(model.inputs.length, 1);
  assert.equal(history.length, 1);
  assert.equal(history[0].content, 'x'.repeat(44_000));
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

test('createSubagent continues normally below the context handoff watermark', async () => {
  const model = new ContextHandoffModel('done');
  const result = await createSubagent({
    model, tools: [], promptSections: [],
    messages: [new HumanMessage('small delegated task context')],
    contextWindowTokens: 12_000, maxIterations: 20,
  });

  assert.equal(model.inputs.length, 1);
  assert.equal(result.output, 'done');
  assert.ok(!result.messages.some(message => ToolMessage.isInstance(message)
    && message.name === 'runtime_budget_status'));
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

  assert.equal(Object.hasOwn(result ?? {}, 'completionReason'), false);
  assert.equal(result.output, result.messages.at(-1)?.text);
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

  assert.equal(Object.hasOwn(result ?? {}, 'completionReason'), false);
  assert.equal(result.output, progress.text);
  assert.ok(
    model.callCount > 20,
    `expected the raised default budget to allow many model calls, got ${model.callCount}`,
  );
});

test('createSubagent reports no output when a limited run has no AI text deliverable', async () => {
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
      new AIMessage('上一轮的交付不能充当本轮交付。'),
      new HumanMessage('continue'),
    ],
    maxIterations: 1,
  });

  assert.equal(Object.hasOwn(result ?? {}, 'completionReason'), false);
  assert.equal(result.output, null);
});

test('model budget preserves fractional and disabled limits without accepting context overrides', async () => {
  const noop = tool(async () => 'x', { name: 'noop', description: 'no-op', schema: z.object({}) });
  class FiniteModel extends NeverConvergingModel {
    async _generate() {
      if (this.callCount < 2) return super._generate();
      this.callCount++;
      return { generations: [{ message: new AIMessage('done'), text: 'done' }] };
    }
  }
  for (const maxIterations of [2.5, 0, Number.NaN]) {
    const model = new FiniteModel({});
    const result = await createSubagent({ model, tools: [noop], promptSections: [],
      messages: [new HumanMessage('go')], maxIterations,
    });
    assert.equal(model.callCount, maxIterations === 2.5 ? 2 : 3);
    assert.equal(readSubagentGuardStopReason(result.messages.at(-1)!),
      maxIterations === 2.5 ? 'subagent_iteration_limit_reached' : null);
  }
  const model = new NeverConvergingModel({});
  const result = await createSubagent({ model, tools: [noop], promptSections: [],
    messages: [new HumanMessage('go')], maxIterations: 1,
    runtimeContext: { runLimit: 99, threadLimit: 0, exitBehavior: 'error' },
  });
  assert.equal(model.callCount, 1);
  assert.equal(readSubagentGuardStopReason(result.messages.at(-1)!), 'subagent_iteration_limit_reached');
});

test('the model budget also limits responses supplied by caller middleware', async () => {
  const noop = tool(async () => 'x', { name: 'noop', description: 'no-op', schema: z.object({}) });
  let responses = 0;
  const model = new NeverConvergingModel({});
  const result = await createSubagent({ model, tools: [noop], promptSections: [],
    messages: [new HumanMessage('go')], maxIterations: 1,
    middleware: [createMiddleware({ name: 'CachedResponse', wrapModelCall: () => {
      responses++;
      return new AIMessage({ content: '', tool_calls: [{ id: `cached-${responses}`, name: 'noop', args: {} }] });
    } })],
  });
  assert.equal(responses, 1);
  assert.equal(model.callCount, 0);
  assert.equal(readSubagentGuardStopReason(result.messages.at(-1)!), 'subagent_iteration_limit_reached');
});


test('invocation output and token usage exclude the supplied history', async () => {
  class UsageModel extends BaseChatModel {
    _llmType() { return 'invocation-usage'; }
    bindTools() { return this; }
    async _generate() {
      const message = new AIMessage({ content: 'Current result',
        usage_metadata: { input_tokens: 30, output_tokens: 5, total_tokens: 35 },
      });
      return { generations: [{ message, text: message.text }] };
    }
  }
  const prior = new AIMessage({ content: 'Earlier result',
    usage_metadata: { input_tokens: 100, output_tokens: 20, total_tokens: 120 },
  });
  const result = await createSubagent({ model: new UsageModel({}), tools: [], promptSections: [],
    messages: [new HumanMessage('Earlier request'), prior, new HumanMessage('Current request')],
  });
  assert.equal(result.output, 'Current result');
  assert.deepEqual(result.tokenUsage, { inputTokens: 30, outputTokens: 5, totalTokens: 35 });
  assert.ok(result.messages.some(message => message.id === prior.id), 'native transcript remains intact');
});
