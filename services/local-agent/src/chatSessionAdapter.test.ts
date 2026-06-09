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
    async getState() {
      return { tasks: [] };
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

test('runChatSession materializes ReviewSpec for human review interrupts', async () => {
  const emittedEvents: LocalAgentEvent[] = [];
  const setup = {
    graphKey: 'test',
    graphConfig: {},
    input: {
      messages: [],
    },
  } as unknown as AgentChannelSetup;
  const graphService = {
    async getState() {
      return { tasks: [] };
    },
    async *stream() {
      yield [
        'values',
        {
          __interrupt__: [{
            value: {
              kind: 'human_review',
              prompt: 'Approve shell command?',
              actionRequests: [{
                name: 'shell',
                args: { command: 'npm test' },
                description: 'Run tests',
              }],
              reviewConfigs: [{
                actionName: 'shell',
                allowedDecisions: ['approve', 'reject', 'respond'],
              }],
            },
          }],
        },
      ];
    },
  };

  const result = await runChatSession({
    request: {
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
  assert.equal(event.requestId, 'req-1');
  assert.equal(event.prompt, 'Approve shell command?');
  assert.equal(event.review?.schemaVersion, 1);
  assert.equal(event.review?.view.body.includes('Approve shell command?'), true);
  assert.deepEqual(event.review?.options.map((option) => option.id), ['approve', 'reject', 'respond']);
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

  let getStateCalls = 0;
  const graphService = {
    async getState() {
      getStateCalls += 1;
      return {
        values: {
          messages: getStateCalls === 1 ? snapshotMessages : finalMessages,
        },
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
