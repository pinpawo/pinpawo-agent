import assert from 'node:assert/strict';
import test from 'node:test';
import { AIMessage, HumanMessage } from '@langchain/core/messages';
import type { AgentChannelSetup } from './agentChannel';
import type { LocalAgentEvent } from './events/localAgentEvent';
import type { LocalAgentServerMessage } from './localAgentProtocol';
import type { LocalAgentGraphService } from './agentGraphService';
import { runChatSession } from './chatSessionAdapter';
import type { StreamToolsPayload } from './agentStreamEvents';

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
    emit: (event) => {
      emittedEvents.push(event);
    },
    emitToolLog: (event) => {
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
  const emittedServerMessages = emittedEvents as LocalAgentServerMessage[];
  assert.equal(
    emittedServerMessages.some((message) =>
      message.type === 'event' && message.event.type === 'message.completed',
    ),
    true,
  );
});

test('runChatSession emits token usage in completed event', async () => {
  const emittedEvents: unknown[] = [];
  const setup = {
    graphKey: 'test',
    graphConfig: {},
    input: {
      messages: [new HumanMessage('你是谁？')],
    },
  } as unknown as AgentChannelSetup;

  const graphService = {
    async getState() {
      return {
        values: {
          messages: [
            new HumanMessage('历史消息'),
          ],
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
          messages: [
            new HumanMessage('你是谁？'),
            new AIMessage('你好，'),
            new AIMessage('这里是回执。'),
          ],
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
    emit: (event) => {
      emittedEvents.push(event);
    },
    emitToolLog: () => {},
  });

  assert.deepEqual(result, { status: 'completed', reply: '这里是回执。' });
  const emittedServerMessages = emittedEvents as LocalAgentServerMessage[];
  const completed = emittedServerMessages
    .map((message): LocalAgentEvent | null => message.type === 'event' ? message.event : null)
    .find((message): message is LocalAgentEvent => Boolean(message && message.type === 'message.completed')) ?? null;
  assert.equal(completed?.type, 'message.completed');
  assert.equal(completed?.role, 'assistant');
  assert.equal(completed.usage?.contextWindow, 32000);
  assert.equal(typeof completed.usage?.inputTokens, 'number');
  assert.equal(typeof completed.usage?.outputTokens, 'number');
  assert.equal(typeof completed.usage?.totalTokens, 'number');
  assert.equal(completed.usage?.inputTokens >= 0, true);
  assert.equal(completed.usage?.outputTokens >= 0, true);
  assert.equal(completed.usage?.totalTokens >= 0, true);
});
