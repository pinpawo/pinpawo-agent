import test from 'node:test';
import assert from 'node:assert/strict';
import { AIMessage, HumanMessage } from '@langchain/core/messages';
import type { BaseMessage } from '@langchain/core/messages';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import type { RunnableConfig } from '@langchain/core/runnables';
import {
  compactOrchestratorMessages,
  createContextCompactionMessage,
  isContextCompactionMessage,
} from './contextCompaction';
import {
  getAgentMessageMetadata,
  setAgentMessageDelegationScope,
  setAgentMessageMetadata,
} from '../messages';
import { DelegationAnnounceMessage } from './delegation';

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

test('orchestrator context compaction is a no-op when there is nothing outside the kept suffix', async () => {
  const messages = [new HumanMessage('hello'), usageMessage('hi', 400)];

  const result = await compactOrchestratorMessages({
    messages,
    model: fakeSummaryModel(),
  });

  assert.equal(result.compacted, false);
  assert.deepEqual(result.messages, []);
});

test('orchestrator context compaction summarizes old messages and keeps recent suffix', async () => {
  const messages: BaseMessage[] = Array.from({ length: 14 }, (_, index) => longMessage(index));
  messages.push(usageMessage('模型已经看到了较长主线。', 900));

  const result = await compactOrchestratorMessages({
    messages,
    model: fakeSummaryModel('保留用户目标、已完成修改、未完成测试。'),
    options: { keepMessages: 4 },
  });

  assert.equal(result.compacted, true);
  assert.equal(result.mainMessageCount, 15);
  assert.equal(result.messages.length, 6);
  assert.ok(result.messages[1] instanceof AIMessage);
  assert.equal(isContextCompactionMessage(result.messages[1]), true);
  assert.match(String(result.messages[1].content), /^<context_summary role="context" source="compaction">/);
  assert.match(String(result.messages[1].content), /保留用户目标、已完成修改、未完成测试。/);
  assert.equal(getAgentMessageMetadata(result.messages[1]).authority, 'none');
  assert.deepEqual(
    result.messages.slice(2).map((message) => message.content),
    messages.slice(-4).map((message) => message.content),
  );
});

test('orchestrator context compaction forwards runnable config to summary model', async () => {
  let seenConfig: RunnableConfig | undefined;
  const messages: BaseMessage[] = Array.from({ length: 14 }, (_, index) => longMessage(index));
  messages.push(usageMessage('模型已经看到了较长主线。', 900));

  const result = await compactOrchestratorMessages({
    messages,
    model: fakeSummaryModel('summary with config', (_messages, config) => {
      seenConfig = config;
    }),
    options: { keepMessages: 4 },
    runnableConfig: {
      configurable: {
        requestId: 'request-1',
      },
    },
  });

  assert.equal(result.compacted, true);
  assert.equal(seenConfig?.configurable?.requestId, 'request-1');
});

test('orchestrator context compaction replaces the prior summary with one cumulative message', async () => {
  let summaryInput = '';
  const priorSummary = createContextCompactionMessage('第一次压缩摘要', 12);
  const messages: BaseMessage[] = [
    priorSummary,
    ...Array.from({ length: 20 }, (_, index) => longMessage(index)),
    usageMessage('模型已经看到了新的较长主线。', 900),
  ];

  const result = await compactOrchestratorMessages({
    messages,
    model: fakeSummaryModel('合并后的压缩摘要', (input) => {
      summaryInput = input.map((message) => String((message as BaseMessage).content)).join('\n');
    }),
    options: { keepMessages: 4 },
  });

  assert.equal(result.compacted, true);
  assert.equal(result.messages.filter(isContextCompactionMessage).length, 1);
  assert.equal(isContextCompactionMessage(result.messages[1]), true);
  assert.match(String(result.messages[1].content), /合并后的压缩摘要/);
  assert.match(summaryInput, /### 已有压缩摘要[\s\S]*第一次压缩摘要/);
  assert.doesNotMatch(summaryInput, /### 主线 agent 回复[\s\S]*第一次压缩摘要/);
});

test('orchestrator context compaction passes the complete old history to the summarizer', async () => {
  let summaryInput = '';
  const priorSummary = createContextCompactionMessage(`prior ${'p'.repeat(2000)}`, 12);
  const messages: BaseMessage[] = [
    priorSummary,
    new HumanMessage('new-context-marker'),
    usageMessage('keep this recent message', 900),
  ];

  await compactOrchestratorMessages({
    messages,
    model: fakeSummaryModel('combined summary', (input) => {
      summaryInput = input.map((message) => String((message as BaseMessage).content)).join('\n');
    }),
    options: { keepMessages: 1 },
  });

  assert.match(summaryInput, /prior/);
  assert.match(summaryInput, /p{2000}/);
  assert.match(summaryInput, /new-context-marker/);
});

test('orchestrator context compaction summarizes a complete accepted main announce', async () => {
  let summaryInput = '';
  const resultTail = 'DELEGATION_RESULT_TAIL_MARKER';
  const acceptedAnnounce = new DelegationAnnounceMessage({
    id: 'delegation-announce:run-1:delegation-1:announce-1',
    sourceLane: 'capability:general',
    delegationId: 'delegation-1',
    runId: 'run-1',
    announceMessageId: 'announce-1',
    task: '生成完整报告',
    result: `${'大结果内容 '.repeat(6000)}${resultTail}`,
    createdAt: '2026-08-24T00:00:00.000Z',
  });
  const messages: BaseMessage[] = [
    new HumanMessage('用户目标：保留完整的委派结果并总结。'),
    acceptedAnnounce,
    usageMessage('保留在当前上下文的最新消息。', 900),
  ];

  const result = await compactOrchestratorMessages({
    messages,
    model: fakeSummaryModel('summary', (input) => {
      summaryInput = input.map((message) => String((message as BaseMessage).content)).join('\n');
    }),
    options: { keepMessages: 1 },
  });

  assert.match(summaryInput, /用户目标：保留完整的委派结果并总结。/);
  assert.ok(summaryInput.includes(JSON.stringify(acceptedAnnounce.text)), 'legacy result remains complete');
  assert.match(summaryInput, new RegExp(resultTail));
  assert.equal(
    result.messages.some((message) => message.id === acceptedAnnounce.id),
    false,
  );
});

test('orchestrator context compaction pins every unaccepted lane announce outside the suffix', async () => {
  const firstAnnounce = setAgentMessageDelegationScope(new DelegationAnnounceMessage({
    id: 'announce-1',
    sourceLane: 'capability:general',
    runId: 'run-1',
    delegationId: 'delegation-1',
    announceMessageId: 'announce-1',
    task: null,
    result: 'FIRST_ATTEMPT',
    createdAt: '2026-08-31T00:00:00.000Z',
  }), {
    lane: 'capability:general',
    runId: 'run-1',
    delegationId: 'delegation-1',
  });
  const secondAnnounce = setAgentMessageDelegationScope(new DelegationAnnounceMessage({
    id: 'announce-2',
    sourceLane: 'capability:general',
    runId: 'run-1',
    delegationId: 'delegation-1',
    announceMessageId: 'announce-2',
    task: null,
    result: 'SECOND_ATTEMPT',
    createdAt: '2026-08-31T00:00:00.000Z',
  }), {
    lane: 'capability:general',
    runId: 'run-1',
    delegationId: 'delegation-1',
  });
  const messages: BaseMessage[] = [
    new HumanMessage('完成任务'),
    firstAnnounce,
    ...Array.from({ length: 12 }, (_, index) => longMessage(index)),
    secondAnnounce,
    usageMessage('模型已经看到了较长主线。', 900),
  ];

  const result = await compactOrchestratorMessages({
    messages,
    model: fakeSummaryModel('summary'),
    options: {
      keepMessages: 1,
      preserveAnnouncesFor: {
        lane: 'capability:general',
        runId: 'run-1',
        delegationId: 'delegation-1',
      },
    },
  });

  assert.equal(result.compacted, true);
  assert.deepEqual(
    result.messages
      .filter((message) => message.id === 'announce-1' || message.id === 'announce-2')
      .map((message) => message.id),
    ['announce-1', 'announce-2'],
  );
});

test('summary failures and empty output stop without replacing canonical history', async () => {
  const messages = [createContextCompactionMessage('Prior constraints.', 12),
    ...Array.from({ length: 14 }, (_, index) => longMessage(index))];
  const snapshot = messages.map((message) => message.toDict());
  for (const failure of [true, false]) {
    const model = { invoke: async () => {
      if (failure) throw new Error('summary unavailable');
      return new AIMessage(' ');
    } } as unknown as BaseChatModel;
    await assert.rejects(compactOrchestratorMessages({ messages, model, options: { keepMessages: 4 } }),
      failure ? /summary unavailable/ : /empty summary/);
    assert.deepEqual(messages.map((message) => message.toDict()), snapshot);
  }
});

test('orchestrator context compaction uses handoff copies and excludes every lane message', async () => {
  let summaryRequest = '';
  const messages: BaseMessage[] = Array.from({ length: 10 }, (_, index) => longMessage(index));
  messages.push(new HumanMessage('用户要求：整理素材并生成交付结果。'));
  messages.push(usageMessage('模型已经看到了较长主线和任务结果。', 900));
  messages.push(new AIMessage('主线 handoff：素材已经整理完成，输出了 canonical-result.md。'));

  const subagentDetail = new AIMessage(`subagent verbose detail ${'z'.repeat(3200)}`);
  setAgentMessageMetadata(subagentDetail, {
    lane: 'capability:general',
    runId: 'turn-1',
    delegationId: 'task-1',
    task: '整理素材',
  });
  messages.push(subagentDetail);

  const announce = setAgentMessageDelegationScope(new DelegationAnnounceMessage({
    id: 'task-1-announce',
    sourceLane: 'capability:general',
    runId: 'turn-1',
    delegationId: 'task-1',
    announceMessageId: 'task-1-announce',
    task: '整理素材',
    result: '素材已经整理完成，输出了 result.md。',
    createdAt: '2026-08-31T00:00:00.000Z',
  }), {
    lane: 'capability:general',
    runId: 'turn-1',
    delegationId: 'task-1',
  });
  messages.push(announce);

  const orchestratorMessage = new AIMessage('内部路由决策，不应进入摘要。');
  setAgentMessageMetadata(orchestratorMessage, { lane: 'orchestrator', runId: 'turn-1' });
  messages.push(orchestratorMessage);

  messages.push(new HumanMessage('最后保留的用户消息'));

  const result = await compactOrchestratorMessages({
    messages,
    model: fakeSummaryModel('lane-aware summary', (modelMessages) => {
      summaryRequest = String((modelMessages.at(-1) as { content?: unknown } | undefined)?.content ?? '');
    }),
    options: { keepMessages: 1 },
  });

  assert.equal(result.compacted, true);
  assert.match(summaryRequest, /主线用户输入/);
  assert.match(summaryRequest, /用户要求：整理素材并生成交付结果/);
  assert.match(summaryRequest, /主线 handoff：素材已经整理完成，输出了 canonical-result\.md/);
  assert.doesNotMatch(summaryRequest, /任务执行记录/);
  assert.doesNotMatch(summaryRequest, /任务：整理素材/);
  assert.doesNotMatch(summaryRequest, /结果：素材已经整理完成，输出了 result\.md/);
  assert.doesNotMatch(summaryRequest, /subagent verbose detail/);
  assert.doesNotMatch(summaryRequest, /内部路由决策/);
});

test('aggressive compaction keeps all main attempts of unfinished work and summarizes other scopes', async () => {
  const attempt = (id: string, runId: string) => new DelegationAnnounceMessage({
    id, sourceLane: 'capability:general', delegationId: 'active', runId, announceMessageId: id,
    task: 'Verify work.', result: `Evidence ${id}`, createdAt: '2026-09-05T00:00:00Z',
  });
  const first = attempt('first', 'previous-run');
  const second = attempt('second', 'previous-run');
  const other = attempt('other', 'older-run');
  let summaryInput = '';
  const recent = new HumanMessage('Continue verification.');
  const result = await compactOrchestratorMessages({
    messages: [first, other, ...Array.from({ length: 12 }, (_, i) => longMessage(i)), second, recent],
    model: fakeSummaryModel('Summary of other work.', (messages) => { summaryInput = String((messages.at(-1) as BaseMessage | undefined)?.content); }),
    options: { keepMessages: 1, preserveAnnouncesFor: { lane: 'capability:general', runId: 'previous-run', delegationId: 'active' } },
  });
  assert.deepEqual(result.messages.slice(2), [first, second, recent]);
  assert.equal(summaryInput.includes(first.text), false);
  assert.equal(summaryInput.includes(second.text), false);
  assert.equal(summaryInput.includes(other.text), true);
});

test('compaction separates current-task evidence from older history and folds each summary on resume', async () => {
  const task = (message: BaseMessage) => setAgentMessageMetadata(message, { traceId: 'current-goal' });
  const evidence = task(new DelegationAnnounceMessage({
    id: 'active-evidence', sourceLane: 'capability:general', runId: 'previous-run', delegationId: 'active',
    announceMessageId: 'active-evidence', task: 'Verify changes.', result: 'KEEP_VERBATIM', createdAt: '2026-09-05T00:00:00Z',
  }));
  const requests: string[] = [];
  const model = { invoke: async (messages: BaseMessage[]) => {
    const text = String(messages.at(-1)?.content); requests.push(text);
    return new AIMessage(text.includes('CURRENT_TASK_FACT') ? 'CURRENT_TASK_FACT summary' : 'UNRELATED_TASK_FACT summary');
  } } as unknown as BaseChatModel;
  const options = { traceId: 'current-goal', keepMessages: 1,
    preserveAnnouncesFor: { lane: 'capability:general', runId: 'previous-run', delegationId: 'active' } };
  let messages: BaseMessage[] = [new HumanMessage('UNRELATED_TASK_FACT'), task(new HumanMessage('CURRENT_TASK_FACT')),
    evidence, task(new HumanMessage('Continue.'))];
  for (let round = 0; round < 2; round += 1) {
    const result = await compactOrchestratorMessages({ messages, model, options });
    messages = result.messages.slice(1);
    assert.equal(messages.filter(isContextCompactionMessage).length, 2);
    assert.ok(messages.includes(evidence));
    const currentSummary = messages.find((message) => isContextCompactionMessage(message)
      && getAgentMessageMetadata(message).traceId === 'current-goal');
    assert.ok(currentSummary);
    assert.match(String(currentSummary.content), /CURRENT_TASK_FACT/);
    assert.doesNotMatch(String(currentSummary.content), /UNRELATED_TASK_FACT/);
    messages.push(task(new HumanMessage('Additional current-task input.')));
  }
  assert.equal(requests.length, 4);
  for (const request of requests) {
    assert.equal(request.includes('CURRENT_TASK_FACT') && request.includes('UNRELATED_TASK_FACT'), false);
    assert.equal(request.includes('KEEP_VERBATIM'), false);
  }
});
