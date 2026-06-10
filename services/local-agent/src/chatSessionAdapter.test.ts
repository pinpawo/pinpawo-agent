import assert from 'node:assert/strict';
import test from 'node:test';
import { AIMessage, HumanMessage, type BaseMessage } from '@langchain/core/messages';
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
  const notice = emittedEvents.find((event) => event.type === 'system.notice');
  assert.equal(notice?.requestId, 'req-1');
  assert.equal(
    notice?.type === 'system.notice' ? notice.message : '',
    '已授权当前会话中的 run_shell 操作。',
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
  assert.equal(emittedEvents[0]?.type, 'human_review.requested');
  assert.deepEqual(
    emittedEvents[0]?.type === 'human_review.requested' ? emittedEvents[0].review : null,
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
