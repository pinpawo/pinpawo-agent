import assert from 'node:assert/strict';
import test from 'node:test';
import { WebSocket } from 'ws';
import type { BaseCheckpointSaver } from '@langchain/langgraph-checkpoint';
import {
  sendLocalAgentEvent,
  sendLocalAgentMessage,
} from './localAgentProtocol';
import type { AgentChannelSetup } from './agentChannel';
import type { AgentContext } from './contextLoader';
import { InflightRequestController } from './inflightRequestController';
import { LocalAgentAppChatHandler } from './localAgentAppChatHandler';

function createFakeWebSocket(sent: unknown[]) {
  return {
    readyState: WebSocket.OPEN,
    send(data: string) {
      sent.push(JSON.parse(data) as unknown);
    },
  } as unknown as WebSocket;
}

function createInflightController() {
  return new InflightRequestController<WebSocket>({
    forceInterruptMs: 1,
    emitOperation: (ws, event) => sendLocalAgentEvent(ws, event),
    sendControl: (ws, message) => sendLocalAgentMessage(ws, message),
    log: () => undefined,
  });
}

function createSetup(): AgentChannelSetup {
  return {
    graphKey: 'test',
    graphConfig: {} as AgentChannelSetup['graphConfig'],
    input: {
      messages: [],
      toolkits: [{
        name: 'local-toolkit',
        description: 'local toolkit',
        operations: {
          read_file: {
            title: '读文件',
            summarizeInput: (input: unknown) => {
              const path = input && typeof input === 'object' && 'path' in input
                ? (input as { path?: unknown }).path
                : null;
              return typeof path === 'string' ? { target: path } : null;
            },
          },
        },
      }],
    } as AgentChannelSetup['input'],
  };
}

function createHandler(overrides: Partial<ConstructorParameters<typeof LocalAgentAppChatHandler>[0]> = {}) {
  const sent: unknown[] = [];
  const deletedThreads: string[] = [];
  const buildInputs: Array<Record<string, unknown>> = [];
  const ws = createFakeWebSocket(sent);
  const handler = new LocalAgentAppChatHandler({
    graphService: {} as ConstructorParameters<typeof LocalAgentAppChatHandler>[0]['graphService'],
    checkpoint: {} as BaseCheckpointSaver,
    deleteThread: async (threadId) => {
      deletedThreads.push(threadId);
    },
    inflightRequests: createInflightController(),
    isCurrentSocket: (candidate) => candidate === ws,
    getActorId: () => 'pet-a',
    getLlmConfig: () => ({
      provider: 'openai',
      model: 'test-model',
      apiKey: 'test-key',
      baseUrl: 'https://example.test/v1',
    } as ConstructorParameters<typeof LocalAgentAppChatHandler>[0]['getLlmConfig'] extends () => infer T ? T : never),
    getPluginToolkits: () => [{ name: 'plugin-toolkit' }] as ConstructorParameters<typeof LocalAgentAppChatHandler>[0]['getPluginToolkits'] extends () => infer T ? T : never,
    getLocalToolkits: () => [{ name: 'local-toolkit' }] as ConstructorParameters<typeof LocalAgentAppChatHandler>[0]['getLocalToolkits'] extends () => infer T ? T : never,
    getLocalCapabilities: () => [{ name: 'browser' }] as ConstructorParameters<typeof LocalAgentAppChatHandler>[0]['getLocalCapabilities'] extends () => infer T ? T : never,
    getUserCapabilities: () => [{
      meta: { id: 'user-cap' },
      capability: { name: 'user-capability' },
    }] as ConstructorParameters<typeof LocalAgentAppChatHandler>[0]['getUserCapabilities'] extends () => infer T ? T : never,
    loadContext: async () => ({} as AgentContext),
    buildChatSetup: (params) => {
      buildInputs.push(params as unknown as Record<string, unknown>);
      return createSetup();
    },
    runChat: async () => ({ status: 'completed', reply: 'done reply' }),
    ...overrides,
  });
  return { handler, ws, sent, deletedThreads, buildInputs };
}

test('LocalAgentAppChatHandler rejects chat requests without userId', async () => {
  let loadedContext = false;
  const { handler, ws, sent } = createHandler({
    loadContext: async () => {
      loadedContext = true;
      return {} as AgentContext;
    },
  });

  await handler.handleChatRequest(ws, {
    type: 'chat_request',
    requestId: 'req-missing-user',
    message: 'hello',
  });

  assert.equal(loadedContext, false);
  assert.deepEqual(sent, [{
    type: 'event',
    requestId: 'req-missing-user',
    event: {
      type: 'error',
      requestId: 'req-missing-user',
      message: 'userId is required',
    },
  }]);
});

test('LocalAgentAppChatHandler resets app chat checkpoint by explicit user thread', async () => {
  const { handler, deletedThreads } = createHandler();

  await handler.handleNewSession({
    type: 'new_session',
    userId: ' user-1 ',
  });

  assert.deepEqual(deletedThreads, ['petbot:chat:pet:pet-a:user:user-1']);
});

test('LocalAgentAppChatHandler runs app chat with typed events and operation output', async () => {
  const { handler, ws, sent, buildInputs } = createHandler({
    runChat: async (options) => {
      assert.equal(options.isCurrent(), true);
      assert.ok(options.setup.input.signal instanceof AbortSignal);
      options.emitEvent({
        type: 'message.delta',
        requestId: 'req-1',
        role: 'assistant',
        text: 'hello',
      });
      options.emitToolEvent({
        event: 'on_tool_start',
        name: 'read_file',
        input: { path: 'README.md' },
      });
      options.emitToolEvent({
        event: 'on_tool_end',
        name: 'read_file',
        output: { path: 'README.md' },
      });
      options.emitEvent({
        type: 'message.completed',
        requestId: 'req-1',
        role: 'assistant',
        text: 'done reply',
        metadata: { mood: null, topic: null, tags: [] },
      });
      return { status: 'completed', reply: 'done reply' };
    },
  });

  await handler.handleChatRequest(ws, {
    type: 'chat_request',
    requestId: 'req-1',
    message: 'hello',
    userId: 'user-1',
  });

  assert.equal(buildInputs.length, 1);
  assert.equal(buildInputs[0]?.userMessage, 'hello');
  assert.equal(buildInputs[0]?.threadId, 'petbot:chat:pet:pet-a:user:user-1');
  assert.equal(buildInputs[0]?.interfaceKind, 'app-chat');
  assert.deepEqual((buildInputs[0]?.toolkits as Array<{ name?: string }>).map((toolkit) => toolkit.name), [
    'plugin-toolkit',
    'local-toolkit',
  ]);

  const eventMessages = sent.filter((item): item is { type: string; event?: { type?: string; phase?: string; operation?: { kind?: string; target?: string } } } =>
    Boolean(item && typeof item === 'object' && (item as { type?: unknown }).type === 'event'),
  );
  assert.deepEqual(eventMessages.map((item) => item.event?.type), [
    'message.delta',
    'operation',
    'operation',
    'message.completed',
  ]);
  assert.deepEqual(eventMessages.map((item) => item.event?.phase).filter(Boolean), ['started', 'completed']);
  assert.deepEqual(
    eventMessages
      .map((item) => item.event?.operation)
      .filter(Boolean)
      .map((operation) => [operation?.kind, operation?.target]),
    [['local-toolkit.read_file', 'README.md'], ['local-toolkit.read_file', undefined]],
  );
});
