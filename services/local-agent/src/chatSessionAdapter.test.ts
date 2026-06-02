import assert from 'node:assert/strict';
import test from 'node:test';
import { AIMessage } from '@langchain/core/messages';
import type { AgentChannelSetup } from './agentChannel';
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
