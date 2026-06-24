import assert from 'node:assert/strict';
import test from 'node:test';
import { AIMessage, HumanMessage, type BaseMessage } from '@langchain/core/messages';
import {
  GLOBAL_REVIEW_POLICY_MODE,
  GLOBAL_REVIEW_POLICY_RUNTIME_EVENT,
} from '@pinpawo/pet-agent';
import type { AgentChannelSetup } from './agentChannel';
import type { LocalAgentEvent } from './events/localAgentEvent';
import type { LocalAgentGraphService } from './agentGraphService';
import { runChatSession } from './chatSessionAdapter';
import { readFinalMessageText, type StreamToolsPayload } from './agentStreamEvents';

function estimateTestTokens(messages: BaseMessage[]) {
  return messages.reduce((total, message) => {
    const content = readFinalMessageText(message);
    const metadata = message.additional_kwargs && Object.keys(message.additional_kwargs).length > 0
      ? JSON.stringify(message.additional_kwargs)
      : '';
    return total + Math.max(0, Math.ceil(`${message._getType()}\n${content}\n${metadata}`.length / 4));
  }, 0);
}

test('runChatSession uses onToolEvent as the only operation source', async () => {
  const emittedTools: StreamToolsPayload[] = [];
  const emittedEvents: unknown[] = [];
  const setup = {
    graphKey: 'test',
    graphConfig: {},
    input: {
      messages: [],
    },
  } as unknown as AgentChannelSetup;

  const graphService = {
    async readThreadState() {
      return { messages: [], pendingHumanReview: null, hasPendingContinuation: false };
    },
    async *stream(streamSetup: AgentChannelSetup) {
      yield [
        'tools',
        {
          event: 'on_tool_start',
          name: 'stream-source',
          toolCallId: 'stream-call',
          input: { source: 'stream' },
        },
      ];
      streamSetup.input.onToolEvent?.({
        event: 'on_tool_start',
        name: 'callback-source',
        toolCallId: 'callback-call',
        input: { source: 'callback' },
      });
      yield [
        'values',
        {
          messages: [new AIMessage('done')],
        },
      ];
    },
  };

  const result = await runChatSession({
    request: {
      kind: 'user_message',
      requestId: 'req-1',
      message: 'hello',
    },
    setup,
    graphService: graphService as unknown as LocalAgentGraphService,
    isCurrent: () => true,
    finishInterrupted: () => {
      throw new Error('should not interrupt');
    },
    emitEvent: (event) => {
      emittedEvents.push(event);
    },
    emitToolEvent: (event) => {
      emittedTools.push(event);
    },
  });

  assert.deepEqual(result, { status: 'completed', reply: 'done' });
  assert.equal(setup.input.messages.length, 1);
  assert.equal(setup.input.messages[0]?._getType(), 'human');
  assert.equal(readFinalMessageText(setup.input.messages[0] ?? {}), 'hello');
  assert.deepEqual(emittedTools, [
    {
      event: 'on_tool_start',
      name: 'callback-source',
      toolCallId: 'callback-call',
      input: { source: 'callback' },
    },
  ]);
  assert.equal((setup.input as { onToolEvent?: unknown }).onToolEvent, undefined);
  assert.equal(
    emittedEvents.some((event) =>
      Boolean(event && typeof event === 'object' && (event as { type?: unknown }).type === 'message.completed'),
    ),
    true,
  );
});

test('runChatSession falls back to checkpoint final message when stream values omit messages', async () => {
  const emittedEvents: LocalAgentEvent[] = [];
  const finalMessages = [
    new HumanMessage('hello'),
    new AIMessage('checkpoint answer'),
  ];
  const setup = {
    graphKey: 'test',
    graphConfig: {},
    input: {
      messages: [],
    },
  } as unknown as AgentChannelSetup;

  let readThreadStateCalls = 0;
  const graphService = {
    async readThreadState() {
      readThreadStateCalls += 1;
      return {
        messages: readThreadStateCalls === 1 ? [] : finalMessages,
        pendingHumanReview: null,
        hasPendingContinuation: false,
      };
    },
    async *stream() {},
  };

  const result = await runChatSession({
    request: {
      kind: 'user_message',
      requestId: 'req-1',
      message: 'hello',
    },
    setup,
    graphService: graphService as unknown as LocalAgentGraphService,
    isCurrent: () => true,
    finishInterrupted: () => {
      throw new Error('should not interrupt');
    },
    emitEvent: (event) => {
      emittedEvents.push(event);
    },
    emitToolEvent: () => {},
  });

  assert.deepEqual(result, { status: 'completed', reply: 'checkpoint answer' });
  assert.equal(readThreadStateCalls, 2);
  const completed = emittedEvents.find(
    (event): event is Extract<LocalAgentEvent, { type: 'message.completed' }> =>
      event.type === 'message.completed',
  ) ?? null;
  assert.equal(completed?.text, 'checkpoint answer');
});

test('runChatSession maps authorization runtime events to system notices', async () => {
  const emittedTools: StreamToolsPayload[] = [];
  const emittedEvents: LocalAgentEvent[] = [];
  const setup = {
    graphKey: 'test',
    graphConfig: {},
    input: {
      messages: [],
    },
  } as unknown as AgentChannelSetup;

  const graphService = {
    async readThreadState() {
      return { messages: [], pendingHumanReview: null, hasPendingContinuation: false };
    },
    async *stream(streamSetup: AgentChannelSetup) {
      streamSetup.input.onToolEvent?.({
        event: 'on_runtime_event',
        name: GLOBAL_REVIEW_POLICY_RUNTIME_EVENT.AUTO_AUTHORIZED,
        data: {
          toolName: 'write_file',
          policyMode: GLOBAL_REVIEW_POLICY_MODE.AUTO_AUTHORIZATION,
        },
      });
      streamSetup.input.onToolEvent?.({
        event: 'on_runtime_event',
        name: GLOBAL_REVIEW_POLICY_RUNTIME_EVENT.CUSTOM_AUTHORIZED,
        data: {
          toolName: 'custom_tool',
          policyMode: GLOBAL_REVIEW_POLICY_MODE.CUSTOM,
        },
      });
      streamSetup.input.onToolEvent?.({
        event: 'on_runtime_event',
        name: 'tool_authorization_recorded',
        data: {
          authorizations: [{
            toolName: 'run_shell',
            matcher: { type: 'shell_pattern', value: 'git status' },
            createdAt: '2026-01-01T00:00:00.000Z',
          }],
        },
      });
      yield [
        'values',
        {
          messages: [new AIMessage('done')],
        },
      ];
    },
  };

  const result = await runChatSession({
    request: {
      kind: 'user_message',
      requestId: 'req-1',
      message: 'hello',
    },
    setup,
    graphService: graphService as unknown as LocalAgentGraphService,
    isCurrent: () => true,
    finishInterrupted: () => {
      throw new Error('should not interrupt');
    },
    emitEvent: (event) => {
      emittedEvents.push(event);
    },
    emitToolEvent: (event) => {
      emittedTools.push(event);
    },
  });

  assert.deepEqual(result, { status: 'completed', reply: 'done' });
  assert.deepEqual(emittedTools, []);
  assert.deepEqual(
    emittedEvents
      .filter((event) => event.type === 'system.notice')
      .map((event) => event.message),
    [
      '已自动授权 write_file 操作。',
      '已根据全局策略授权 custom_tool 操作。',
      '已授权当前会话中的 run_shell 操作。',
    ],
  );
});

test('runChatSession forwards subagent model text runtime events as subagent deltas', async () => {
  const emittedTools: StreamToolsPayload[] = [];
  const emittedEvents: LocalAgentEvent[] = [];
  const setup = {
    graphKey: 'test',
    graphConfig: {},
    input: {
      messages: [],
    },
  } as unknown as AgentChannelSetup;

  const graphService = {
    async readThreadState() {
      return { messages: [], pendingHumanReview: null, hasPendingContinuation: false };
    },
    async *stream(streamSetup: AgentChannelSetup) {
      streamSetup.input.onToolEvent?.({
        event: 'on_runtime_event',
        name: 'subagent_message_delta',
        data: { text: '正在整理' },
      });
      yield [
        'values',
        {
          messages: [new AIMessage('done')],
        },
      ];
    },
  };

  const result = await runChatSession({
    request: {
      kind: 'user_message',
      requestId: 'req-1',
      message: 'hello',
    },
    setup,
    graphService: graphService as unknown as LocalAgentGraphService,
    isCurrent: () => true,
    finishInterrupted: () => {
      throw new Error('should not interrupt');
    },
    emitEvent: (event) => {
      emittedEvents.push(event);
    },
    emitToolEvent: (event) => {
      emittedTools.push(event);
    },
  });

  assert.deepEqual(result, { status: 'completed', reply: 'done' });
  assert.deepEqual(emittedTools, []);
  assert.deepEqual(
    emittedEvents.filter((event) => event.type === 'subagent.message.delta'),
    [{
      type: 'subagent.message.delta',
      requestId: 'req-1',
      text: '正在整理',
    }],
  );
});

test('runChatSession forwards canonical review interrupt specs unchanged', async () => {
  const emittedEvents: LocalAgentEvent[] = [];
  const setup = {
    graphKey: 'test',
    graphConfig: {},
    input: {
      messages: [],
    },
  } as unknown as AgentChannelSetup;
  const review = {
    id: 'review-direct',
    schemaVersion: 1,
    view: {
      kind: 'plain' as const,
      title: 'Shell command approval',
      body: 'Run git status?',
    },
    options: [{
      id: 'approve',
      label: 'Approve',
      decision: { type: 'approve' as const },
    }],
  };
  const graphService = {
    async readThreadState() {
      return { messages: [], pendingHumanReview: null, hasPendingContinuation: false };
    },
    async *stream() {
      yield [
        'values',
        {
          __interrupt__: [{
            value: {
              kind: 'review',
              review,
              pendingAction: {
                actionId: 'call-1',
                toolName: 'run_shell',
                args: { command: 'git status', cwd: '/repo' },
                description: 'Run git status?',
              },
            },
          }],
        },
      ];
    },
  };

  const result = await runChatSession({
    request: {
      kind: 'user_message',
      requestId: 'req-1',
      message: 'hello',
    },
    setup,
    graphService: graphService as unknown as LocalAgentGraphService,
    isCurrent: () => true,
    finishInterrupted: () => {
      throw new Error('should not interrupt');
    },
    emitEvent: (event) => {
      emittedEvents.push(event);
    },
    emitToolEvent: () => {},
  });

  assert.deepEqual(result, { status: 'waiting_human' });
  const event = emittedEvents[0];
  assert.equal(event?.type, 'human_review.requested');
  assert.deepEqual(event.review, review);
});

test('runChatSession resumes explicit response after state update clears interrupt payload', async () => {
  const emittedEvents: LocalAgentEvent[] = [];
  const streamInputs: unknown[] = [];
  const resume = { reviewId: 'review-1', selectedOptionId: 'approve' };
  const finalMessages = [new AIMessage('approved')];
  const setup = {
    graphKey: 'test',
    graphConfig: {},
    input: {
      messages: [],
    },
  } as unknown as AgentChannelSetup;

  let readThreadStateCalls = 0;
  const graphService = {
    async readThreadState() {
      readThreadStateCalls += 1;
      return readThreadStateCalls === 1
        ? { messages: [], pendingHumanReview: null, hasPendingContinuation: true }
        : { messages: finalMessages, pendingHumanReview: null, hasPendingContinuation: false };
    },
    buildResumeCommand(value: unknown) {
      return { kind: 'resume-command', value };
    },
    async *stream(_setup: AgentChannelSetup, inputOverride?: unknown) {
      streamInputs.push(inputOverride);
      yield [
        'values',
        {
          messages: finalMessages,
        },
      ];
    },
  };

  const result = await runChatSession({
    request: {
      kind: 'resume',
      requestId: 'req-1',
      resume,
    },
    setup,
    graphService: graphService as unknown as LocalAgentGraphService,
    isCurrent: () => true,
    finishInterrupted: () => {
      throw new Error('should not interrupt');
    },
    emitEvent: (event) => {
      emittedEvents.push(event);
    },
    emitToolEvent: () => {},
  });

  assert.deepEqual(result, { status: 'completed', reply: 'approved' });
  assert.deepEqual(streamInputs, [{
    kind: 'resume-command',
    value: resume,
  }]);
  assert.deepEqual(setup.input.messages, []);
  assert.equal(
    emittedEvents.some((event) => event.type === 'human_review.requested'),
    false,
  );
});

test('runChatSession allows a user message after an aborted non-review run leaves pending continuation', async () => {
  const finalMessages = [new AIMessage('continued after abort')];
  const emittedEvents: LocalAgentEvent[] = [];
  const setup = {
    graphKey: 'test',
    graphConfig: {},
    input: {
      messages: [],
    },
  } as unknown as AgentChannelSetup;
  const streamInputs: unknown[] = [];
  let readThreadStateCalls = 0;
  const graphService = {
    async readThreadState() {
      readThreadStateCalls += 1;
      return readThreadStateCalls === 1
        ? { messages: [], pendingHumanReview: null, hasPendingContinuation: true }
        : { messages: finalMessages, pendingHumanReview: null, hasPendingContinuation: false };
    },
    async *stream(streamSetup: AgentChannelSetup, inputOverride?: unknown) {
      streamInputs.push(inputOverride);
      assert.equal(readFinalMessageText(streamSetup.input.messages.at(-1) ?? {}), 'new request');
      yield [
        'values',
        {
          messages: finalMessages,
        },
      ];
    },
  };

  const result = await runChatSession({
    request: {
      kind: 'user_message',
      requestId: 'req-1',
      message: 'new request',
    },
    setup,
    graphService: graphService as unknown as LocalAgentGraphService,
    isCurrent: () => true,
    finishInterrupted: () => {
      throw new Error('should not interrupt');
    },
    emitEvent: (event) => {
      emittedEvents.push(event);
    },
    emitToolEvent: () => {},
  });

  assert.deepEqual(result, { status: 'completed', reply: 'continued after abort' });
  assert.deepEqual(streamInputs, [undefined]);
  assert.equal(
    emittedEvents.some((event) => event.type === 'human_review.requested' || event.type === 'system.notice'),
    false,
  );
});

test('runChatSession rejects stale resume with user-facing message', async () => {
  const setup = {
    graphKey: 'test',
    graphConfig: {},
    input: {
      messages: [],
    },
  } as unknown as AgentChannelSetup;
  const graphService = {
    async readThreadState() {
      return { messages: [], pendingHumanReview: null, hasPendingContinuation: false };
    },
    buildResumeCommand() {
      throw new Error('should not build resume command');
    },
    async *stream() {
      throw new Error('should not stream');
    },
  };

  await assert.rejects(
    () => runChatSession({
      request: {
        kind: 'resume',
        requestId: 'req-1',
        resume: { reviewId: 'review-1', selectedOptionId: 'approve' },
      },
      setup,
      graphService: graphService as unknown as LocalAgentGraphService,
      isCurrent: () => true,
      finishInterrupted: () => {
        throw new Error('should not interrupt');
      },
      emitEvent: () => {},
      emitToolEvent: () => {},
    }),
    /review 已关闭或不存在/,
  );
});

test('runChatSession does not map pending review free text to review response', async () => {
  const streamInputs: unknown[] = [];
  const emittedEvents: LocalAgentEvent[] = [];
  const review = {
    id: 'review-respond',
    schemaVersion: 1,
    view: {
      kind: 'plain' as const,
      body: 'Need guidance?',
    },
    options: [{
      id: 'respond',
      label: 'Respond',
      input: {
        kind: 'text' as const,
        key: 'message' as const,
        required: true,
      },
      decision: { type: 'respond' as const, messageInputKey: 'message' as const },
    }],
  };
  const finalMessages = [new AIMessage('continued')];
  const setup = {
    graphKey: 'test',
    graphConfig: {},
    input: {
      messages: [],
    },
  } as unknown as AgentChannelSetup;
  const graphService = {
    async readThreadState() {
      return { messages: [], pendingHumanReview: { review }, hasPendingContinuation: true };
    },
    buildResumeCommand(value: unknown) {
      throw new Error(`should not build resume command: ${String(value)}`);
    },
    async *stream(_setup: AgentChannelSetup, inputOverride?: unknown) {
      streamInputs.push(inputOverride);
      yield [
        'values',
        {
          messages: finalMessages,
        },
      ];
    },
  };

  const result = await runChatSession({
    request: {
      kind: 'user_message',
      requestId: 'req-1',
      message: '请先解释风险',
    },
    setup,
    graphService: graphService as unknown as LocalAgentGraphService,
    isCurrent: () => true,
    finishInterrupted: () => {
      throw new Error('should not interrupt');
    },
    emitEvent: (event) => {
      emittedEvents.push(event);
    },
    emitToolEvent: () => {},
  });

  assert.deepEqual(result, { status: 'waiting_human' });
  assert.deepEqual(streamInputs, []);
  assert.deepEqual(setup.input.messages, []);
  assert.equal(emittedEvents[0]?.type, 'system.notice');
  assert.match(
    emittedEvents[0]?.type === 'system.notice' ? emittedEvents[0].message : '',
    /确认面板/,
  );
  assert.equal(emittedEvents[1]?.type, 'human_review.requested');
  assert.deepEqual(
    emittedEvents[1]?.type === 'human_review.requested' ? emittedEvents[1].review : null,
    review,
  );
});

test('runChatSession emits token usage in completed event', async () => {
  const emittedEvents: unknown[] = [];
  const promptMessages = [
    new HumanMessage('历史问题'),
    new AIMessage('历史回答'),
    new HumanMessage('你是谁？'),
  ];
  const snapshotMessages = [
    new HumanMessage('已保存的历史消息'),
  ];
  const finalMessages = [
    ...snapshotMessages,
    ...promptMessages,
    new AIMessage('这里是回执。'),
  ];
  const setup = {
    graphKey: 'test',
    graphConfig: {},
    input: {
      messages: promptMessages,
    },
  } as unknown as AgentChannelSetup;

  let readThreadStateCalls = 0;
  const graphService = {
    async readThreadState() {
      readThreadStateCalls += 1;
      return {
        messages: readThreadStateCalls === 1 ? snapshotMessages : finalMessages,
        pendingHumanReview: null,
        hasPendingContinuation: false,
      };
    },
    async *stream(streamSetup: AgentChannelSetup) {
      yield [
        'messages',
        [
          new AIMessage('你好，'),
          { node: 'assistant' },
        ],
      ];
      yield [
        'values',
        {
          messages: finalMessages,
        },
      ];
    },
  };

  const result = await runChatSession({
    request: {
      kind: 'user_message',
      requestId: 'req-1',
      message: '你是谁？',
    },
    setup,
    graphService: graphService as unknown as LocalAgentGraphService,
    isCurrent: () => true,
    finishInterrupted: () => {
      throw new Error('should not interrupt');
    },
    emitEvent: (event) => {
      emittedEvents.push(event);
    },
    emitToolEvent: () => {},
  });

  assert.deepEqual(result, { status: 'completed', reply: '这里是回执。' });
  const completed = (emittedEvents as LocalAgentEvent[])
    .find((message): message is LocalAgentEvent => message.type === 'message.completed') ?? null;
  assert.equal(completed?.type, 'message.completed');
  assert.equal(completed?.role, 'assistant');
  assert.equal(completed.usage?.contextWindow, 32000);
  assert.equal(completed.usage?.inputTokens, estimateTestTokens([...snapshotMessages, ...promptMessages]));
  assert.equal(completed.usage?.totalTokens, estimateTestTokens(finalMessages));
  assert.equal(typeof completed.usage?.outputTokens, 'number');
  assert.equal(completed.usage?.outputTokens >= 0, true);
});
