import assert from 'node:assert/strict';
import test from 'node:test';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { AIMessage, HumanMessage, ToolMessage } from '@langchain/core/messages';
import type {
  CapabilityArtifactStore,
  CapabilityFinalizeContext,
  CapabilityFinalizeResult,
  OrchestrationDecisionStructuredOutputConfig,
  SubagentResult,
} from '@pinpawo/pet-agent';
import {
  createExploreCapability,
  readExploreResult,
} from './index';

function summaryMessage(summary: string) {
  return new AIMessage({
    content: ['Explore summary:', '', summary].join('\n'),
  });
}

function contextSummaryMessage(summary: string) {
  return new HumanMessage({
    content: summary,
    additional_kwargs: { lc_source: 'summarization' },
  });
}

function fakeSummaryModel(
  summary: string,
  capture?: (params: { messages: Array<{ content?: unknown }>; options: unknown }) => void,
  evidence: Array<{ source: string; proves: string; value: string }> = [],
) {
  return {
    withStructuredOutput: (_schema: unknown, options: unknown) => ({
      invoke: async (messages: Array<{ content?: unknown }>) => {
        capture?.({ messages, options });
        return { summary, evidence };
      },
    }),
  } as unknown as BaseChatModel;
}

async function createFinalizeHarness(
  model: BaseChatModel,
  opts: {
    structuredOutput?: OrchestrationDecisionStructuredOutputConfig;
    artifactStore?: CapabilityArtifactStore;
    messages?: CapabilityFinalizeContext['messages'];
  } = {},
) {
  const capability = createExploreCapability({ structuredOutput: opts.structuredOutput });
  const finalize = capability.lifecycle?.finalize;
  assert.ok(finalize);
  return {
    middleware: {
      afterRun: async (
        result: SubagentResult,
        context: Partial<CapabilityFinalizeContext>,
      ): Promise<CapabilityFinalizeResult | void> => finalize(result, {
        models: { act: model },
        actor: {} as never,
        messages: opts.messages ?? [],
        artifactStore: opts.artifactStore,
        capabilityId: 'explore',
        delegationId: 'delegation',
        runId: 'run',
        ...context,
      }),
    },
  };
}

test('explore capability declares immutable instructions and host Toolkits statically', () => {
  assert.deepEqual(
    createExploreCapability().uses,
    ['bash', 'git', 'artifact_discovery'],
  );
  const capability = createExploreCapability({
    uses: ['bash', 'git', 'browser'],
  });

  assert.deepEqual(capability.uses, ['bash', 'git', 'browser']);
  const instructions = capability.instructions.content;
  assert.match(instructions, /只读取、检查、搜索、观察和总结上下文/);
  assert.match(instructions, /gh_pr_view[\s\S]*gh_pr_diff[\s\S]*git_diff[\s\S]*git_show/);
  assert.match(instructions, /不要使用 browser[\s\S]*http_fetch[\s\S]*download_file/);
  assert.match(instructions, /较早执行上下文总结为摘要/);
  assert.match(instructions, /已查看文件列表/);
  assert.match(capability.instructions.digest, /^[a-f0-9]{64}$/);
  assert.equal(typeof capability.lifecycle?.finalize, 'function');
});

test('explore result reads the latest Explore summary marker', () => {
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

test('explore result marks limit-reached summaries as progress', () => {
  const summary = 'progress summary\n\n已查看文件：packages/pet-agent/src/subagent/createSubagent.ts';
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

test('explore result does not treat free-form assistant text as an ingested result', () => {
  assert.equal(readExploreResult([
    new AIMessage('free-form assistant text should not become an explore result'),
  ]), null);
});

test('explore final ingest includes LangChain context summaries and persists one report', async () => {
  const summary = '最终归纳：保留了早期证据、近期结果和明确来源。';
  const evidence = [{
    source: 'packages/pet-agent/src/subagent/createSubagent.ts',
    proves: 'subagent uses built-in summarization',
    value: 'context management no longer needs capability callbacks',
  }];
  let capturedHuman = '';
  let capturedOptions: unknown;
  const writes: Array<{ content?: string; evidence?: unknown[] }> = [];
  const recorded: unknown[] = [];
  const store = {
    writeArtifact: async (input: { artifact: { content?: string; metadata?: { evidence?: unknown[] } } }) => {
      writes.push({
        content: input.artifact.content,
        evidence: input.artifact.metadata?.evidence,
      });
      return {
        id: 'explore-final-1',
        uri: 'capability-artifact://thread-1/dg-1/run-1',
        kind: 'report' as const,
      };
    },
  } as unknown as CapabilityArtifactStore;
  const structuredOutput: OrchestrationDecisionStructuredOutputConfig = { method: 'functionCalling' };
  const harness = await createFinalizeHarness(fakeSummaryModel(summary, ({ messages, options }) => {
    capturedHuman = String(messages.at(-1)?.content ?? '');
    capturedOptions = options;
  }, evidence), { artifactStore: store, structuredOutput });

  const result = {
    messages: [
      contextSummaryMessage('Earlier subagent context summary:\n\n已查看 src/old.ts，并确认旧实现行为。'),
      new ToolMessage({
        tool_call_id: 'call-new',
        name: 'view_file_chunk',
        content: '近期工具结果：createSubagent 已切换到 summarizationMiddleware。',
      }),
      new AIMessage('最终判断：可以删除 rewriteAsync。'),
    ],
    artifacts: [],
    completionReason: 'natural' as const,
    announceMessageId: null,
  };

  const returned = await harness.middleware?.afterRun?.(result, {
    recordCapabilityArtifact: (ref) => {
      recorded.push(ref);
    },
    threadId: 'thread-1',
    capabilityId: 'explore',
    delegationId: 'dg-1',
    runId: 'run-1',
  });

  assert.match(capturedHuman, /已查看 src\/old\.ts/);
  assert.match(capturedHuman, /createSubagent 已切换/);
  assert.match(capturedHuman, /最终判断：可以删除 rewriteAsync/);
  assert.deepEqual(capturedOptions, {
    name: 'explore_knowledge_ingest',
    method: 'functionCalling',
  });
  assert.equal(writes.length, 1);
  assert.equal(writes[0]?.content, summary);
  assert.deepEqual(writes[0]?.evidence, evidence);
  assert.equal(recorded.length, 1);
  assert.match(String(returned?.messages?.at(-1)?.content ?? ''), /Explore summary:/);
  assert.match(String(returned?.messages?.at(-1)?.content ?? ''), /最终归纳/);
  assert.ok(returned?.messages?.at(-1)?.id);
  assert.equal(returned?.announceMessageId, returned?.messages?.at(-1)?.id);
});

test('explore finalize exposes a generated limit summary as the announce', async () => {
  const harness = await createFinalizeHarness(fakeSummaryModel('进度摘要：已完成依赖检查，源码仍待继续读取。'));
  const returned = await harness.middleware?.afterRun?.({
    messages: [
      new HumanMessage('继续探查 repo'),
      new AIMessage({
        content: '先读取依赖信息。',
        tool_calls: [{ id: 'call-limit', name: 'view_file_chunk', args: { path: 'package.json' } }],
      }),
      new ToolMessage({
        tool_call_id: 'call-limit',
        name: 'view_file_chunk',
        content: '已确认 package.json 中的主要依赖。',
      }),
    ],
    artifacts: [],
    completionReason: 'limit_reached',
    announceMessageId: null,
  }, {
    recordCapabilityArtifact: () => {},
    threadId: 'thread-limit',
    capabilityId: 'explore',
    delegationId: 'dg-limit',
    runId: 'run-limit',
  });

  const generatedSummary = returned?.messages?.at(-1);
  assert.match(String(generatedSummary?.content ?? ''), /进度摘要/);
  assert.ok(generatedSummary?.id);
  assert.equal(returned?.announceMessageId, generatedSummary?.id);
});

test('explore finalize preserves an existing subagent announce', async () => {
  const harness = await createFinalizeHarness(fakeSummaryModel('整理后的 Explore summary。'));
  const returned = await harness.middleware?.afterRun?.({
    messages: [new AIMessage({ id: 'subagent-announce', content: '原始交付。' })],
    artifacts: [],
    completionReason: 'natural',
    announceMessageId: 'subagent-announce',
  }, {
    recordCapabilityArtifact: () => {},
    threadId: 'thread-natural',
    capabilityId: 'explore',
    delegationId: 'dg-natural',
    runId: 'run-natural',
  });

  assert.match(String(returned?.messages?.at(-1)?.content ?? ''), /整理后的 Explore summary/);
  assert.equal(returned?.announceMessageId, 'subagent-announce');
});

test('explore finalize uses the previous summary when final ingest fails', async () => {
  const previous = '已有摘要：已检查 src/existing.ts。';
  const model = {
    withStructuredOutput: () => ({
      invoke: async () => {
        throw new Error('structured output unavailable');
      },
    }),
  } as unknown as BaseChatModel;
  const writes: string[] = [];
  const store = {
    writeArtifact: async (input: { artifact: { content?: string } }) => {
      writes.push(String(input.artifact.content ?? ''));
      return { id: 'fallback', uri: 'artifact://fallback', kind: 'report' as const };
    },
  } as unknown as CapabilityArtifactStore;
  const harness = await createFinalizeHarness(model, {
    artifactStore: store,
    messages: [summaryMessage(previous)],
  });

  const returned = await harness.middleware?.afterRun?.({
    messages: [summaryMessage(previous), new AIMessage('new final answer')],
    artifacts: [],
    completionReason: 'natural',
    announceMessageId: null,
  }, {
    recordCapabilityArtifact: () => {},
    threadId: 'thread-fallback',
    capabilityId: 'explore',
    delegationId: 'dg-fallback',
    runId: 'run-fallback',
  });

  assert.deepEqual(writes, [previous]);
  assert.equal(returned?.messages?.length, 2);
});

test('explore finalize appends a refreshed summary after a continuation', async () => {
  const previous = '旧摘要：已检查 src/old.ts。';
  const refreshed = '新摘要：已检查 src/old.ts 和 src/new.ts。';
  const harness = await createFinalizeHarness(fakeSummaryModel(refreshed), {
    messages: [summaryMessage(previous)],
  });

  const returned = await harness.middleware?.afterRun?.({
    messages: [summaryMessage(previous), new AIMessage('new evidence from src/new.ts')],
    artifacts: [],
    completionReason: 'natural',
    announceMessageId: null,
  }, {
    recordCapabilityArtifact: () => {},
    threadId: 'thread-refresh',
    capabilityId: 'explore',
    delegationId: 'dg-refresh',
    runId: 'run-refresh',
  });

  assert.equal(returned?.messages?.length, 3);
  assert.match(String(returned?.messages?.at(-1)?.content ?? ''), /新摘要/);
  assert.deepEqual(readExploreResult(returned?.messages ?? [])?.summary, refreshed);
});

test('explore final ingest keeps the newest tool results within its evidence budget', async () => {
  let capturedHuman = '';
  const harness = await createFinalizeHarness(fakeSummaryModel('budgeted summary', ({ messages }) => {
    capturedHuman = String(messages.at(-1)?.content ?? '');
  }));
  const toolResults = Array.from({ length: 12 }, (_, index) => new ToolMessage({
    tool_call_id: `call-${index}`,
    name: 'view_file_chunk',
    content: `result-${index}\n${String(index).repeat(2_000)}`,
  }));

  await harness.middleware?.afterRun?.({
    messages: [...toolResults, new AIMessage('final answer')],
    artifacts: [],
    completionReason: 'natural',
    announceMessageId: null,
  }, {
    recordCapabilityArtifact: () => {},
    threadId: 'thread-budget',
    capabilityId: 'explore',
    delegationId: 'dg-budget',
    runId: 'run-budget',
  });

  assert.match(capturedHuman, /result-11/);
  assert.doesNotMatch(capturedHuman, /result-0\n/);
});

test('explore artifact persistence failure is non-fatal', async () => {
  const summary = 'final summary';
  const harness = await createFinalizeHarness(fakeSummaryModel(summary), {
    artifactStore: {
      writeArtifact: async () => {
        throw new Error('store unavailable');
      },
    } as unknown as CapabilityArtifactStore,
  });

  const returned = await harness.middleware?.afterRun?.({
    messages: [new AIMessage('final evidence')],
    artifacts: [],
    completionReason: 'natural',
    announceMessageId: null,
  }, {
    recordCapabilityArtifact: () => {},
    threadId: 'thread-error',
    capabilityId: 'explore',
    delegationId: 'dg-error',
    runId: 'run-error',
  });

  assert.match(String(returned?.messages?.at(-1)?.content ?? ''), /final summary/);
});
