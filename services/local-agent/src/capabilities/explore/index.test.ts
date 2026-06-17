import assert from 'node:assert/strict';
import test from 'node:test';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { AIMessage, ToolMessage, type BaseMessage } from '@langchain/core/messages';
import type { CapabilityContext, OrchestrationDecisionStructuredOutputConfig } from '@pinpawo/pet-agent';
import {
  createExploreCapability,
  exploreResultSchema,
  readExploreResult,
} from './index';

function summaryMessage(summary: string) {
  return new AIMessage({
    content: ['Explore summary:', '', summary].join('\n'),
    additional_kwargs: {
      pinpawo: {
        exploreSummary: summary,
      },
    },
  });
}

function toolResult(id: string, content: string) {
  return new ToolMessage({
    content,
    tool_call_id: id,
    name: 'view_file_chunk',
  });
}

function fakeSummaryModel(
  summary: string,
  capture?: (params: { messages: Array<{ content?: unknown }>; options: unknown }) => void,
) {
  return {
    withStructuredOutput: (_schema: unknown, options: unknown) => ({
      invoke: async (messages: Array<{ content?: unknown }>) => {
        capture?.({ messages, options });
        return { summary };
      },
    }),
  } as unknown as BaseChatModel;
}

async function createRuntime(
  model: BaseChatModel,
  opts: {
    structuredOutput?: OrchestrationDecisionStructuredOutputConfig;
    artifactStore?: CapabilityContext['artifactStore'];
  } = {},
) {
  return createExploreCapability({ structuredOutput: opts.structuredOutput }).createRuntime({
    models: { act: model },
    actor: {} as never,
    messages: [],
    availableToolkits: [],
    artifactStore: opts.artifactStore,
  });
}

test('explore capability filters default toolkits to host-available toolkits', async () => {
  const capability = createExploreCapability();
  const runtime = await capability.createRuntime({
    models: {} as never,
    actor: {} as never,
    messages: [],
    availableToolkits: [
      { name: 'bash', description: 'local files and shell' },
      { name: 'git', description: 'git tools' },
      { name: 'browser', description: 'browser tools' },
    ],
  });

  assert.deepEqual(runtime.uses, ['bash', 'browser']);
  assert.equal(Array.isArray(runtime.instructions), true);
  assert.match(Array.isArray(runtime.instructions) ? runtime.instructions.join('\n') : '', /只读取、检查、搜索、观察和总结上下文/);
  assert.match(Array.isArray(runtime.instructions) ? runtime.instructions.join('\n') : '', /上下文足够时会保留完整工具输出/);
  assert.match(Array.isArray(runtime.instructions) ? runtime.instructions.join('\n') : '', /已查看文件列表/);
  assert.equal(typeof runtime.contextPolicy?.rewriteAsync, 'function');
  // Explore no longer persists on finalize via afterRun; summarization is
  // context-pressure-driven only (issue #137 follow-up).
  assert.equal(runtime.middleware, undefined);
  assert.equal(capability.resultSchema, exploreResultSchema);
});

test('explore result reads latest capability-private ingested summary as completed by default', () => {
  const summary = 'final summary with evidence\n\n已查看文件：services/local-agent/src/capabilities/explore/index.ts';

  assert.deepEqual(readExploreResult([
    new AIMessage('assistant text should not be used'),
    summaryMessage(summary),
  ]), {
    status: 'completed',
    summary,
    nextSteps: [],
  });
});

test('explore result marks limit-reached ingested summaries as progress', () => {
  const summary = 'progress summary\n\n已查看文件：packages/pet-agent/src/agent/createAgentRuntime.ts';
  const message = new AIMessage('limit reached');
  message.additional_kwargs = {
    pinpawo: {
      announce: 'progress',
      completionReason: 'limit_reached',
    },
  };

  assert.deepEqual(readExploreResult([summaryMessage(summary), message]), {
    status: 'progress',
    summary,
    nextSteps: [],
  });
});

test('explore result does not fall back to latest assistant text without ingest summary', () => {
  assert.equal(readExploreResult([
    new AIMessage('free-form assistant text should not become an explore result'),
  ]), null);
  assert.equal(readExploreResult([
    new AIMessage('<pinpawo_explore_summary>\nlegacy text marker only\n</pinpawo_explore_summary>'),
  ]), null);
});

test('explore context policy leaves raw tool output untouched while under budget', async () => {
  let ingestCalls = 0;
  const runtime = await createRuntime(fakeSummaryModel('should not be used', () => {
    ingestCalls += 1;
  }));
  const messages: BaseMessage[] = [
    toolResult('call-1', `raw file output\n${'x'.repeat(2000)}`),
  ];

  const rewritten = await runtime.contextPolicy?.rewriteAsync?.(messages, {
    estimateMessagesTokens: () => 1_000,
    iterationCount: 1,
    operations: {},
    contextWindowTokens: 32_000,
  });

  assert.equal(rewritten, messages);
  assert.equal(ingestCalls, 0);
  assert.match(String(rewritten?.[0]?.content ?? ''), /^raw file output/);
});

test('explore context policy ingests and compresses older raw tool output only under pressure', async () => {
  let capturedHuman = '';
  const summary = [
    '已确认 context pressure 时才需要摘要。',
    '已查看文件：services/local-agent/src/capabilities/explore/index.ts',
    '关键发现：最近两个工具输出仍保留原文。',
  ].join('\n');
  const runtime = await createRuntime(fakeSummaryModel(summary, ({ messages }) => {
    capturedHuman = String(messages.at(-1)?.content ?? '');
  }));
  const messages: BaseMessage[] = [
    toolResult('call-1', `old raw 1\n${'x'.repeat(1200)}`),
    toolResult('call-2', `old raw 2\n${'y'.repeat(1200)}`),
    toolResult('call-3', `recent raw 3\n${'z'.repeat(1200)}`),
    toolResult('call-4', `recent raw 4\n${'w'.repeat(1200)}`),
  ];

  const rewritten = await runtime.contextPolicy?.rewriteAsync?.(messages, {
    estimateMessagesTokens: () => 30_000,
    iterationCount: 2,
    operations: {},
    contextWindowTokens: 32_000,
  });

  assert.ok(rewritten);
  assert.match(capturedHuman, /触发原因：context_pressure/);
  assert.match(capturedHuman, /old raw 1/);
  assert.match(String(rewritten[0]?.content ?? ''), /^\[explore raw tool output evicted after ingest\]/);
  assert.match(String(rewritten[1]?.content ?? ''), /Explore summary:/);
  assert.match(String(rewritten[1]?.content ?? ''), /已确认 context pressure/);
  assert.match(String(rewritten[2]?.content ?? ''), /^recent raw 3/);
  assert.match(String(rewritten[3]?.content ?? ''), /^recent raw 4/);
  assert.deepEqual(readExploreResult(rewritten)?.summary, summary);
});

test('explore ingest forwards configured structured output method', async () => {
  const summary = '摘要\n\n已查看文件：services/local-agent/src/capabilities/explore/index.ts';
  let capturedOptions: unknown;
  const model = fakeSummaryModel(summary, ({ options }) => {
    capturedOptions = options;
  });
  const structuredOutput: OrchestrationDecisionStructuredOutputConfig = { method: 'functionCalling' };
  const runtime = await createRuntime(model, { structuredOutput });

  const rewritten = await runtime.contextPolicy?.rewriteAsync?.([
    toolResult('call-1', `old raw\n${'x'.repeat(1200)}`),
    toolResult('call-2', `old raw\n${'y'.repeat(1200)}`),
    toolResult('call-3', `old raw\n${'z'.repeat(1200)}`),
  ], {
    estimateMessagesTokens: () => 30_000,
    iterationCount: 2,
    operations: {},
    contextWindowTokens: 32_000,
  });

  assert.deepEqual(capturedOptions, {
    name: 'explore_knowledge_ingest',
    method: 'functionCalling',
  });
  assert.deepEqual(readExploreResult(rewritten ?? [])?.summary, summary);
});

test('explore ingest failure under context pressure keeps raw outputs instead of crashing the run', async () => {
  const model = {
    withStructuredOutput: () => ({
      invoke: async () => {
        throw new Error('invalid structured output');
      },
    }),
  } as unknown as BaseChatModel;
  const runtime = await createRuntime(model);
  assert.ok(runtime.contextPolicy?.rewriteAsync);

  const input = [
    toolResult('call-1', `old raw\n${'x'.repeat(1200)}`),
    toolResult('call-2', `old raw\n${'y'.repeat(1200)}`),
    toolResult('call-3', `old raw\n${'z'.repeat(1200)}`),
  ];
  // An ingest model failure must degrade gracefully (review finding #1): the
  // rewrite returns the original messages unchanged — no throw, no eviction.
  const rewritten = await runtime.contextPolicy!.rewriteAsync!(input, {
    estimateMessagesTokens: () => 30_000,
    iterationCount: 2,
    operations: {},
    contextWindowTokens: 32_000,
  });
  assert.deepEqual(rewritten, input);
});

test('explore context-pressure ingest persists a summary+evidence report artifact via the sink', async () => {
  const summary = '已确认重复探索的原因\n\n已查看文件：services/local-agent/src/capabilities/explore/index.ts';
  const writes: Array<Record<string, unknown>> = [];
  const recorded: unknown[] = [];
  const store = {
    writeArtifact: async (input: Record<string, unknown>) => {
      writes.push(input);
      return { id: `a-${writes.length}`, uri: `capability-artifact://t/d/artifact/${writes.length}`, kind: 'report' };
    },
  } as unknown as NonNullable<CapabilityContext['artifactStore']>;

  const model = {
    withStructuredOutput: () => ({
      invoke: async () => ({
        summary,
        evidence: [{ source: 'explore/index.ts', proves: 'ingest 只在 context 压力时触发', value: '避免重复探索' }],
      }),
    }),
  } as unknown as BaseChatModel;
  const runtime = await createRuntime(model, { artifactStore: store });

  await runtime.contextPolicy?.rewriteAsync?.([
    toolResult('call-1', `old raw\n${'x'.repeat(1200)}`),
    toolResult('call-2', `old raw\n${'y'.repeat(1200)}`),
    toolResult('call-3', `old raw\n${'z'.repeat(1200)}`),
  ], {
    estimateMessagesTokens: () => 30_000,
    iterationCount: 2,
    operations: {},
    contextWindowTokens: 32_000,
    artifactSink: {
      recordCapabilityArtifact: (ref) => { recorded.push(ref); },
      threadId: 'thread-1',
      delegationId: 'dg_1',
      turnId: 'turn_1',
    },
  });

  assert.equal(writes.length, 1);
  const artifact = writes[0]?.artifact as Record<string, unknown>;
  assert.equal(artifact.kind, 'report');
  assert.equal(artifact.mimeType, 'text/markdown');
  assert.deepEqual((artifact.metadata as { evidence?: unknown })?.evidence, [
    { source: 'explore/index.ts', proves: 'ingest 只在 context 压力时触发', value: '避免重复探索' },
  ]);
  assert.equal(recorded.length, 1);
});

test('explore context-pressure ingest is a no-op write when no artifact sink is provided', async () => {
  const summary = '摘要\n\n已查看文件：a.ts';
  const writes: unknown[] = [];
  const store = {
    writeArtifact: async (input: unknown) => { writes.push(input); return { id: 'x', uri: 'u', kind: 'report' }; },
  } as unknown as NonNullable<CapabilityContext['artifactStore']>;
  const runtime = await createRuntime(fakeSummaryModel(summary), { artifactStore: store });

  await runtime.contextPolicy?.rewriteAsync?.([
    toolResult('call-1', `old raw\n${'x'.repeat(1200)}`),
    toolResult('call-2', `old raw\n${'y'.repeat(1200)}`),
    toolResult('call-3', `old raw\n${'z'.repeat(1200)}`),
  ], {
    estimateMessagesTokens: () => 30_000,
    iterationCount: 2,
    operations: {},
    contextWindowTokens: 32_000,
    // no artifactSink
  });

  assert.equal(writes.length, 0);
});
