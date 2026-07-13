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
    getCapabilityArtifactStore: () => ({}) as ConstructorParameters<typeof LocalAgentAppChatHandler>[0]['getCapabilityArtifactStore'] extends () => infer T ? T : never,
    getWorkdir: () => '/tmp/pinpawo-app-workdir',
    getActorName: () => 'Test Actor',
    runStudioRequest: async () => undefined,
    routeStudioHumanReviewResponse: () => false,
    rejectStudioPendingReview: () => undefined,
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
  assert.equal(buildInputs[0]?.workdir, '/tmp/pinpawo-app-workdir');
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
    // The completed event inherits the start event's target even though
    // read_file only describes itself via summarizeInput.
    [['local-toolkit.read_file', 'README.md'], ['local-toolkit.read_file', 'README.md']],
  );
});

test('LocalAgentAppChatHandler keeps app chat session start time stable per user thread', async () => {
  const { handler, ws, buildInputs } = createHandler();

  await handler.handleChatRequest(ws, {
    type: 'chat_request',
    requestId: 'req-1',
    message: 'hello',
    userId: 'user-1',
  });
  await handler.handleChatRequest(ws, {
    type: 'chat_request',
    requestId: 'req-2',
    message: 'again',
    userId: 'user-1',
  });

  assert.equal(buildInputs.length, 2);
  assert.equal(typeof buildInputs[0]?.sessionStartedAt, 'string');
  assert.equal(buildInputs[1]?.sessionStartedAt, buildInputs[0]?.sessionStartedAt);
});

test('LocalAgentAppChatHandler resumes canonical human review responses through cached route', async () => {
  const runRequests: unknown[] = [];
  const review = {
    id: 'review-1',
    schemaVersion: 1,
    view: { kind: 'plain' as const, body: 'Approve?' },
    options: [
      { id: 'approve', label: 'Approve', decision: { type: 'approve' as const } },
      { id: 'reject', label: 'Reject', decision: { type: 'reject' as const } },
    ],
  };
  const { handler, ws, sent, buildInputs } = createHandler({
    runChat: async (options) => {
      runRequests.push(options.request);
      if (options.request.kind === 'user_message') {
        options.emitEvent({
          type: 'human_review.requested',
          requestId: 'req-1',
          interruptId: 'interrupt-1',
          review,
        });
        return { status: 'waiting_human' };
      }
      return { status: 'completed', reply: 'done after review' };
    },
  });

  await handler.handleChatRequest(ws, {
    type: 'chat_request',
    requestId: 'req-1',
    message: 'hello',
    userId: 'user-1',
  });
  await handler.handleHumanReviewResponse(ws, {
    type: 'human_review_response',
    requestId: 'req-1',
    reviewId: 'review-1',
    selectedOptionId: 'approve',
  });
  await handler.handleHumanReviewResponse(ws, {
    type: 'human_review_response',
    requestId: 'req-1',
    reviewId: 'review-1',
    selectedOptionId: 'approve',
  });

  assert.deepEqual(runRequests, [
    {
      kind: 'user_message',
      requestId: 'req-1',
      message: 'hello',
    },
    {
      kind: 'resume',
      requestId: 'req-1',
      resume: {
        'interrupt-1': {
          decisions: [{
            reviewId: 'review-1',
            selectedOptionId: 'approve',
          }],
        },
      },
    },
  ]);
  assert.equal(buildInputs.length, 2);
  assert.equal(buildInputs[1]?.userMessage, '');
  assert.equal(buildInputs[1]?.threadId, 'petbot:chat:pet:pet-a:user:user-1');
  const eventMessages = sent.filter((item): item is { type: string; event?: { type?: string; message?: string } } =>
    Boolean(item && typeof item === 'object' && (item as { type?: unknown }).type === 'event'),
  );
  assert.deepEqual(eventMessages.map((item) => item.event?.type), [
    'human_review.requested',
    'error',
  ]);
  assert.match(eventMessages[1]?.event?.message ?? '', /已关闭|不存在/);
});

test('LocalAgentAppChatHandler cancels pending human review with canonical reject option', async () => {
  const runRequests: unknown[] = [];
  const review = {
    id: 'review-1',
    schemaVersion: 1,
    view: { kind: 'plain' as const, body: 'Approve?' },
    options: [
      { id: 'approve', label: 'Approve', decision: { type: 'approve' as const } },
      { id: 'reject', label: 'Reject', decision: { type: 'reject' as const } },
    ],
  };
  const { handler, ws } = createHandler({
    runChat: async (options) => {
      runRequests.push(options.request);
      if (options.request.kind === 'user_message') {
        options.emitEvent({
          type: 'human_review.requested',
          requestId: 'req-1',
          interruptId: 'interrupt-1',
          review,
        });
        return { status: 'waiting_human' };
      }
      return { status: 'completed', reply: 'interrupted' };
    },
  });

  await handler.handleChatRequest(ws, {
    type: 'chat_request',
    requestId: 'req-1',
    message: 'hello',
    userId: 'user-1',
  });
  await handler.handleReviewCancel(ws, {
    type: 'review.cancel',
    requestId: 'req-1',
    actionId: 'interrupt-1',
  });

  assert.deepEqual(runRequests, [
    {
      kind: 'user_message',
      requestId: 'req-1',
      message: 'hello',
    },
    {
      kind: 'resume',
      requestId: 'req-1',
      resume: {
        'interrupt-1': {
          decisions: [{
            reviewId: 'review-1',
            selectedOptionId: 'reject',
          }],
        },
      },
    },
  ]);
});

test('LocalAgentAppChatHandler rejects cancellation for a stale review action', async () => {
  const runRequests: unknown[] = [];
  const review = {
    id: 'review-1',
    schemaVersion: 1,
    view: { kind: 'plain' as const, body: 'Approve?' },
    options: [{ id: 'reject', label: 'Reject', decision: { type: 'reject' as const } }],
  };
  const { handler, ws, sent } = createHandler({
    runChat: async (options) => {
      runRequests.push(options.request);
      if (options.request.kind === 'user_message') {
        options.emitEvent({
          type: 'human_review.requested',
          requestId: 'req-1',
          interruptId: 'interrupt-current',
          review,
        });
        return { status: 'waiting_human' };
      }
      return { status: 'completed', reply: 'unexpected' };
    },
  });

  await handler.handleChatRequest(ws, {
    type: 'chat_request',
    requestId: 'req-1',
    message: 'hello',
    userId: 'user-1',
  });
  await handler.handleReviewCancel(ws, {
    type: 'review.cancel',
    requestId: 'req-1',
    actionId: 'interrupt-stale',
  });

  assert.equal(runRequests.length, 1);
  const errorEvent = sent.at(-1) as { type?: string; event?: { type?: string; code?: string } };
  assert.equal(errorEvent.type, 'event');
  assert.equal(errorEvent.event?.type, 'error');
  assert.equal(errorEvent.event?.code, 'review_stale');
});

test('LocalAgentAppChatHandler routes human review responses to studio router first', async () => {
  let studioRouted = false;
  const runRequests: unknown[] = [];
  const { handler, ws } = createHandler({
    runStudioRequest: async () => undefined,
    routeStudioHumanReviewResponse: () => {
      studioRouted = true;
      return true;
    },
    runChat: async (options) => {
      runRequests.push(options.request);
      return { status: 'completed', reply: 'chat continued' };
    },
  });

  await handler.handleHumanReviewResponse(ws, {
    type: 'human_review_response',
    requestId: 'req-studio',
    reviewId: 'review-1',
    selectedOptionId: 'approve',
  });

  assert.equal(studioRouted, true);
  assert.deepEqual(runRequests, []);
});

test('LocalAgentAppChatHandler forwards studio requests to runtime handler', async () => {
  let handled = false;
  const { handler, ws } = createHandler({
    runStudioRequest: async (_ws, message) => {
      handled = true;
      assert.equal(_ws, ws);
      assert.equal(message.requestId, 'studio-1');
      assert.equal(message.userRequest, 'plan this task');
      assert.equal(message.runId, 'run-1');
      assert.equal(message.conversationId, 'conv-1');
    },
  });

  await handler.handleStudioRequest(ws, {
    type: 'studio_request',
    requestId: 'studio-1',
    userRequest: 'plan this task',
    runId: 'run-1',
    conversationId: 'conv-1',
  });

  assert.equal(handled, true);
});
