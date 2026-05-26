import test from 'node:test';
import assert from 'node:assert/strict';
import { AIMessage, HumanMessage, SystemMessage } from '@langchain/core/messages';
import type { BaseMessage } from '@langchain/core/messages';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import type { RunnableConfig } from '@langchain/core/runnables';
import {
  CONTEXT_COMPACTION_MESSAGE_NAME,
  compactOrchestratorMessages,
  estimateMessagesTokens,
  isContextCompactionMessage,
  readContextCompactionSummaries,
} from './contextCompaction';
import { setPinpetMeta } from './messageLanes';

function fakeSummaryModel(summary = '旧上下文摘要', onInvoke?: (messages: unknown[], config?: RunnableConfig) => void) {
  return {
    invoke: async (messages: unknown[], config?: RunnableConfig) => {
      onInvoke?.(messages, config);
      return new AIMessage(summary);
    },
  } as unknown as BaseChatModel;
}

function longMessage(index: number) {
  return new HumanMessage(`message-${index} ${'x'.repeat(3200)}`);
}

test('orchestrator context compaction stays idle below high-watermark threshold', async () => {
  const messages = [
    new HumanMessage('hello'),
    new AIMessage('hi'),
  ];

  const result = await compactOrchestratorMessages({
    messages,
    model: fakeSummaryModel(),
    options: { contextWindowTokens: 32000 },
  });

  assert.equal(result.compacted, false);
  assert.deepEqual(result.messages, []);
});

test('orchestrator context compaction summarizes old messages and keeps recent suffix', async () => {
  const messages = Array.from({ length: 14 }, (_, index) => longMessage(index));
  const estimatedTokens = estimateMessagesTokens(messages);

  const result = await compactOrchestratorMessages({
    messages,
    model: fakeSummaryModel('保留用户目标、已完成修改、未完成测试。'),
    options: { contextWindowTokens: 8000, keepMessages: 4 },
  });

  assert.equal(result.compacted, true);
  assert.equal(result.estimatedTokens, estimatedTokens);
  assert.equal(result.messages.length, 6);
  assert.ok(result.messages[1] instanceof SystemMessage);
  assert.equal(isContextCompactionMessage(result.messages[1]), true);
  assert.equal(result.messages[1].content, '保留用户目标、已完成修改、未完成测试。');
  assert.deepEqual(
    result.messages.slice(2).map((message) => message.content),
    messages.slice(-4).map((message) => message.content),
  );
});

test('orchestrator context compaction forwards runnable config to summary model', async () => {
  let seenConfig: RunnableConfig | undefined;
  const messages = Array.from({ length: 14 }, (_, index) => longMessage(index));

  const result = await compactOrchestratorMessages({
    messages,
    model: fakeSummaryModel('summary with config', (_messages, config) => {
      seenConfig = config;
    }),
    options: { contextWindowTokens: 8000, keepMessages: 4 },
    runnableConfig: {
      configurable: {
        requestId: 'request-1',
      },
    },
  });

  assert.equal(result.compacted, true);
  assert.equal(seenConfig?.configurable?.requestId, 'request-1');
});

test('orchestrator context compaction summaries are readable independently from recent messages', () => {
  const firstSummary = new SystemMessage('第一次压缩摘要');
  firstSummary.name = CONTEXT_COMPACTION_MESSAGE_NAME;
  const secondSummary = new SystemMessage('第二次压缩摘要');
  secondSummary.name = CONTEXT_COMPACTION_MESSAGE_NAME;
  const messages = [
    firstSummary,
    new HumanMessage('recent request'),
    secondSummary,
    new AIMessage('recent reply'),
  ];

  assert.deepEqual(readContextCompactionSummaries(messages), ['第一次压缩摘要', '第二次压缩摘要']);
  assert.deepEqual(readContextCompactionSummaries(messages, 1), ['第二次压缩摘要']);
});

test('orchestrator context compaction falls back when summary model fails', async () => {
  const messages = Array.from({ length: 14 }, (_, index) => longMessage(index));
  const model = {
    invoke: async () => {
      throw new Error('summary unavailable');
    },
  } as unknown as BaseChatModel;
  const originalWarn = console.warn;
  console.warn = () => {};

  try {
    const result = await compactOrchestratorMessages({
      messages,
      model,
      options: { contextWindowTokens: 8000, keepMessages: 4 },
    });

    assert.equal(result.compacted, true);
    assert.match(String(result.messages[1].content), /自动压缩摘要/);
    assert.match(String(result.messages[1].content), /message-9/);
  } finally {
    console.warn = originalWarn;
  }
});

test('orchestrator context compaction summarizes lane announces without subagent details', async () => {
  let summaryRequest = '';
  const messages: BaseMessage[] = Array.from({ length: 10 }, (_, index) => longMessage(index));
  messages.push(new HumanMessage('用户要求：整理素材并生成交付结果。'));

  const subagentDetail = new AIMessage(`subagent verbose detail ${'z'.repeat(3200)}`);
  setPinpetMeta(subagentDetail, {
    lane: 'general',
    turnId: 'turn-1',
    delegationId: 'task-1',
    task: '整理素材',
  });
  messages.push(subagentDetail);

  const announce = new AIMessage('素材已经整理完成，输出了 result.md。');
  setPinpetMeta(announce, {
    lane: 'general',
    turnId: 'turn-1',
    announce: 'completed',
    delegationId: 'task-1',
    task: '整理素材',
  });
  messages.push(announce);

  const orchestratorMessage = new AIMessage('内部路由决策，不应进入摘要。');
  setPinpetMeta(orchestratorMessage, { lane: 'orchestrator', turnId: 'turn-1' });
  messages.push(orchestratorMessage);

  messages.push(new HumanMessage('最后保留的用户消息'));

  const result = await compactOrchestratorMessages({
    messages,
    model: fakeSummaryModel('lane-aware summary', (modelMessages) => {
      summaryRequest = String((modelMessages.at(-1) as { content?: unknown } | undefined)?.content ?? '');
    }),
    options: { contextWindowTokens: 8000, keepMessages: 1 },
  });

  assert.equal(result.compacted, true);
  assert.match(summaryRequest, /主线用户输入/);
  assert.match(summaryRequest, /用户要求：整理素材并生成交付结果/);
  assert.match(summaryRequest, /任务执行记录/);
  assert.match(summaryRequest, /任务：整理素材/);
  assert.match(summaryRequest, /结果：素材已经整理完成，输出了 result\.md/);
  assert.doesNotMatch(summaryRequest, /subagent verbose detail/);
  assert.doesNotMatch(summaryRequest, /内部路由决策/);
});
