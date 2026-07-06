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
  });
}

function toolResult(id: string, content: string) {
  return new ToolMessage({
    content,
    tool_call_id: id,
    name: 'view_file_chunk',
  });
}

function contextPolicyCtx() {
  return {
    iterationCount: 2,
    operations: {},
    contextWindowTokens: 1000,
  };
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

  assert.deepEqual(runtime.uses, ['bash', 'git', 'browser']);
  assert.equal(Array.isArray(runtime.instructions), true);
  assert.match(Array.isArray(runtime.instructions) ? runtime.instructions.join('\n') : '', /只读取、检查、搜索、观察和总结上下文/);
  assert.match(Array.isArray(runtime.instructions) ? runtime.instructions.join('\n') : '', /gh_pr_view、gh_pr_diff、git_diff、git_show/);
  assert.match(Array.isArray(runtime.instructions) ? runtime.instructions.join('\n') : '', /不要使用 browser、http_fetch 或 download_file/);
  assert.match(Array.isArray(runtime.instructions) ? runtime.instructions.join('\n') : '', /运行中会保留最近的完整工具输出/);
  assert.match(Array.isArray(runtime.instructions) ? runtime.instructions.join('\n') : '', /已查看文件列表/);
  assert.equal(typeof runtime.contextPolicy?.rewriteAsync, 'function');
  assert.equal(typeof runtime.middleware?.afterRun, 'function');
  assert.equal(capability.resultSchema, exploreResultSchema);
});

test('explore result reads latest summary from Explore summary marker', () => {
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

test('explore context policy leaves recent raw tool output untouched', async () => {
  let ingestCalls = 0;
  const runtime = await createRuntime(fakeSummaryModel('should not be used', () => {
    ingestCalls += 1;
  }));
  const messages: BaseMessage[] = [
    toolResult('call-1', `raw file output\n${'x'.repeat(2000)}`),
  ];

  const rewritten = await runtime.contextPolicy?.rewriteAsync?.(messages, contextPolicyCtx());

  assert.equal(rewritten, messages);
  assert.equal(ingestCalls, 0);
  assert.match(String(rewritten?.[0]?.content ?? ''), /^raw file output/);
});

test('explore context policy ingests and compresses older raw tool output', async () => {
  let capturedHuman = '';
  const summary = [
    '已确认旧工具输出需要摘要。',
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

  const rewritten = await runtime.contextPolicy?.rewriteAsync?.(messages, contextPolicyCtx());

  assert.ok(rewritten);
  assert.match(capturedHuman, /触发原因：old_tool_output/);
  assert.match(capturedHuman, /old raw 1/);
  assert.match(String(rewritten[0]?.content ?? ''), /^\[explore raw tool output evicted after ingest\]/);
  assert.match(String(rewritten[1]?.content ?? ''), /^\[explore raw tool output evicted after ingest\]/);
  assert.equal(rewritten.length, 5);
  assert.match(String(rewritten[4]?.content ?? ''), /Explore summary:/);
  assert.match(String(rewritten[4]?.content ?? ''), /已确认旧工具输出/);
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
  ], contextPolicyCtx());

  assert.deepEqual(capturedOptions, {
    name: 'explore_knowledge_ingest',
    method: 'functionCalling',
  });
  assert.deepEqual(readExploreResult(rewritten ?? [])?.summary, summary);
});

test('explore ingest failure keeps raw outputs instead of crashing the run', async () => {
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
  const rewritten = await runtime.contextPolicy!.rewriteAsync!(input, contextPolicyCtx());
  assert.deepEqual(rewritten, input);
});

test('explore summarizes old tool output and defers report persistence to afterRun', async () => {
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
        evidence: [{ source: 'explore/index.ts', proves: 'ingest 会压缩旧工具输出', value: '避免重复探索' }],
      }),
    }),
  } as unknown as BaseChatModel;
  const runtime = await createRuntime(model, { artifactStore: store });

  const rewritten = await runtime.contextPolicy?.rewriteAsync?.([
    toolResult('call-1', `old raw\n${'x'.repeat(1200)}`),
    toolResult('call-2', `old raw\n${'y'.repeat(1200)}`),
    toolResult('call-3', `old raw\n${'z'.repeat(1200)}`),
  ], {
    ...contextPolicyCtx(),
    artifactSink: {
      recordCapabilityArtifact: (ref) => { recorded.push(ref); },
      threadId: 'thread-1',
      delegationId: 'dg_1',
      runId: 'run_1',
    },
  });

  assert.equal(writes.length, 0);

  const rewrittenSummary = rewritten ? readExploreResult(rewritten) : null;
  assert.ok(rewrittenSummary);

  await runtime.middleware?.afterRun?.(
    {
      messages: rewritten ?? [],
      artifacts: [],
      completionReason: 'natural' as const,
    },
    {
      recordCapabilityArtifact: (ref) => {
        recorded.push(ref);
      },
      threadId: 'thread-1',
      delegationId: 'dg_1',
      runId: 'run_1',
      capabilityId: 'explore',
    },
  );

  assert.equal(writes.length, 1);
  const artifact = writes[0]?.artifact as Record<string, unknown>;
  assert.equal(artifact.kind, 'report');
  assert.equal(artifact.mimeType, 'text/markdown');
  assert.deepEqual((artifact.metadata as { evidence?: unknown })?.evidence, [
    { source: 'explore/index.ts', proves: 'ingest 会压缩旧工具输出', value: '避免重复探索' },
  ]);
  assert.equal(recorded.length, 1);
});

test('explore ingest is a no-op write when no artifact sink is provided', async () => {
  const summary = '摘要\n\n已查看文件：a.ts';
  const writes: unknown[] = [];
  const store = {
    writeArtifact: async (input: unknown) => { writes.push(input); return { id: 'x', uri: 'u', kind: 'report' }; },
  } as unknown as NonNullable<CapabilityContext['artifactStore']>;
  const runtime = await createRuntime(fakeSummaryModel(summary), { artifactStore: store });

  const rewritten = await runtime.contextPolicy?.rewriteAsync?.([
    toolResult('call-1', `old raw\n${'x'.repeat(1200)}`),
    toolResult('call-2', `old raw\n${'y'.repeat(1200)}`),
    toolResult('call-3', `old raw\n${'z'.repeat(1200)}`),
  ], {
    ...contextPolicyCtx(),
    // no artifactSink
  });

  assert.equal(writes.length, 0);
  assert.equal(rewritten?.length, 4);

  await runtime.middleware?.afterRun?.({
    messages: rewritten ?? [],
    artifacts: [],
    completionReason: 'natural' as const,
  }, {
    threadId: 'thread-no-sink-no-callback',
    capabilityId: 'explore',
    delegationId: 'dg-no-sink-no-callback',
    runId: 'run-no-sink-no-callback',
  });

  assert.equal(writes.length, 0);
});

test('explore skips finalize artifact when previous ingest failure marker exists', async () => {
  let captured = 0;
  const store = {
    writeArtifact: async () => {
      captured += 1;
      return { id: 'nope', uri: 'u', kind: 'report' } as const;
    },
  } as unknown as NonNullable<CapabilityContext['artifactStore']>;
  const runtime = await createRuntime(fakeSummaryModel('should_not_be_called'), { artifactStore: store });
  const failureMessage = new AIMessage('临时汇总失败');
  failureMessage.additional_kwargs = {
    pinpawo: {
      exploreIngestFailed: true,
    },
  };

  await runtime.middleware?.afterRun?.(
    {
      messages: [failureMessage],
      artifacts: [],
      completionReason: 'error' as const,
    },
    {
      recordCapabilityArtifact: () => {},
      threadId: 'thread-no-op',
      capabilityId: 'explore',
      delegationId: 'dg-no-op',
      runId: 'run-no-op',
    },
  );

  assert.equal(captured, 0);
});

test('explore stores final summary report artifact on finalize via afterRun', async () => {
  const summary = '最终总结：探索到关键路径和风险边界。已查看文件：services/local-agent/src/capabilities/explore/index.ts';
  const writes: Array<{ summary: string; evidence?: unknown[] }> = [];
  const recorded: unknown[] = [];
  const store = {
    writeArtifact: async (input: { artifact: { content?: string; metadata?: { evidence?: unknown[] } } }) => {
      writes.push({
        summary: String(input.artifact?.content ?? ''),
        evidence: input.artifact?.metadata?.evidence as unknown[] | undefined,
      });
      return {
        id: 'final-1',
        uri: 'capability-artifact://thread-final/dg-final/run-final',
        kind: 'report' as const,
        threadId: 'thread-final',
        capabilityId: 'explore',
        delegationId: 'dg-final',
        runId: 'run-final',
        mimeType: 'text/markdown',
        preview: '',
        sizeBytes: 0,
        createdAt: '2026-01-01T00:00:00.000Z',
      };
    },
  } as unknown as NonNullable<CapabilityContext['artifactStore']>;

  const runtime = await createRuntime(fakeSummaryModel(summary), { artifactStore: store });
  const result = {
    messages: [summaryMessage(summary)],
    artifacts: [],
    completionReason: 'natural' as const,
  };

  const afterRun = runtime.middleware?.afterRun;
  assert.equal(typeof afterRun, 'function');

  const resultReturned = await afterRun?.(result, {
    recordCapabilityArtifact: (ref) => {
      recorded.push(ref);
    },
    threadId: 'thread-final',
    capabilityId: 'explore',
    delegationId: 'dg-final',
    runId: 'run-final',
  });

  assert.deepEqual(resultReturned, result);
  assert.equal(writes.length, 1);
  assert.match(writes[0]?.summary ?? '', /最终总结：探索到关键路径和风险边界/);
  assert.deepEqual(writes[0]?.evidence, []);
  assert.equal(recorded.length, 1);
});

test('explore generates final summary artifact when no exploreSummary marker exists', async () => {
  const summary = '最终归纳：基于对话结尾生成的结构化总结。';
  const writes: Array<{ summary: string; evidence?: unknown[] }> = [];
  const store = {
    writeArtifact: async (input: { artifact: { content?: string; metadata?: { evidence?: unknown[] } } }) => {
      writes.push({
        summary: String(input.artifact?.content ?? ''),
        evidence: input.artifact?.metadata?.evidence as unknown[] | undefined,
      });
      return {
        id: 'final-2',
        uri: 'capability-artifact://thread-final-no-marker/dg-final-no-marker/run-final-no-marker',
        kind: 'report' as const,
        threadId: 'thread-final-no-marker',
        capabilityId: 'explore',
        delegationId: 'dg-final-no-marker',
        runId: 'run-final-no-marker',
        mimeType: 'text/markdown',
        preview: '',
        sizeBytes: 0,
        createdAt: '2026-01-01T00:00:00.000Z',
      };
    },
  } as unknown as NonNullable<CapabilityContext['artifactStore']>;

  let capturedHuman = '';
  const runtime = await createRuntime(fakeSummaryModel(summary, ({ messages }) => {
    capturedHuman = String(messages.at(-1)?.content ?? '');
  }), { artifactStore: store });

  const result = {
    messages: [new AIMessage('最终我认为关键风险是数据库连接抖动，下一步先定位连接池参数与重试策略。')],
    artifacts: [],
    completionReason: 'natural' as const,
  };

  const afterRun = runtime.middleware?.afterRun;
  assert.equal(typeof afterRun, 'function');

  await afterRun?.(result, {
    recordCapabilityArtifact: () => {},
    threadId: 'thread-final-no-marker',
    capabilityId: 'explore',
    delegationId: 'dg-final-no-marker',
    runId: 'run-final-no-marker',
  });

  assert.match(capturedHuman, /触发原因：finalize/);
  assert.equal(writes.length, 1);
  assert.equal(writes[0]?.summary, summary);
  assert.equal(Array.isArray(writes[0]?.evidence), true);
});

test('explore writes at most once per run even when old-output summaries are generated', async () => {
  const summary = '压缩后的总结：仅保留关键证据和来源，避免重复。';
  const writes: Array<Record<string, unknown>> = [];
  const store = {
    writeArtifact: async (input: unknown) => {
      writes.push(input as Record<string, unknown>);
      return {
        id: `run-summary-${writes.length}`,
        uri: `capability-artifact://thread-1/dg-1/run-1/${writes.length}`,
        kind: 'report' as const,
        threadId: 'thread-1',
        capabilityId: 'explore',
        delegationId: 'dg-1',
        runId: 'run-1',
        mimeType: 'text/markdown',
        sizeBytes: 10,
        createdAt: '2026-01-01T00:00:00.000Z',
      } as Record<string, unknown>;
    },
  } as unknown as NonNullable<CapabilityContext['artifactStore']>;
  const model = {
    withStructuredOutput: () => ({
      invoke: async () => ({
        summary,
        evidence: [{ source: 'explore/index.ts', proves: '压缩触发', value: '减少原始输出占用' }],
      }),
    }),
  } as unknown as BaseChatModel;
  const runtime = await createRuntime(model, { artifactStore: store });

  const rewritten = await runtime.contextPolicy?.rewriteAsync?.([
    toolResult('call-1', `old raw\n${'x'.repeat(1200)}`),
    toolResult('call-2', `old raw\n${'y'.repeat(1200)}`),
    toolResult('call-3', `old raw\n${'z'.repeat(1200)}`),
  ], {
    ...contextPolicyCtx(),
    artifactSink: {
      recordCapabilityArtifact: () => {},
      threadId: 'thread-1',
      delegationId: 'dg-1',
      runId: 'run-1',
    },
  });

  assert.ok(Array.isArray(rewritten));
  assert.equal(writes.length, 0);

  const afterRun = runtime.middleware?.afterRun;
  assert.equal(typeof afterRun, 'function');
  await afterRun?.({
    messages: rewritten ?? [],
    artifacts: [],
    completionReason: 'natural' as const,
  }, {
    recordCapabilityArtifact: () => {},
    threadId: 'thread-1',
    capabilityId: 'explore',
    delegationId: 'dg-1',
    runId: 'run-1',
  });

  assert.equal(writes.length, 1);
});
