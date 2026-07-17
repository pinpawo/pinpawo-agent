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
import type { LocalAgentRuntimeEvent } from './events/localAgentRuntimeEvent';
import { createInitialTuiState, createSession } from './tui/state/tuiState';
import { tuiStateReducer } from './tui/state/tuiStateReducer';

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

function createCheckpoint(threadIds: string[]) {
  return {
    async *list() {
      for (const threadId of threadIds) {
        yield { config: { configurable: { thread_id: threadId } } };
      }
    },
  } as unknown as BaseCheckpointSaver;
}

function createHandler(overrides: Partial<ConstructorParameters<typeof LocalAgentAppChatHandler>[0]> = {}) {
  const sent: unknown[] = [];
  const deletedThreads: string[] = [];
  const buildInputs: Array<Record<string, unknown>> = [];
  const ws = createFakeWebSocket(sent);
  const handler = new LocalAgentAppChatHandler({
    graphService: {} as ConstructorParameters<typeof LocalAgentAppChatHandler>[0]['graphService'],
    checkpoint: createCheckpoint([]),
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
      const setup = createSetup();
      setup.input.threadId = params.threadId;
      return setup;
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
    now: () => 1000,
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

  const eventMessages = sent.filter((item): item is {
    type: 'event';
    requestId: string;
    event: LocalAgentRuntimeEvent;
  } =>
    Boolean(item && typeof item === 'object' && (item as { type?: unknown }).type === 'event'),
  );
  assert.deepEqual(eventMessages.map((item) => item.event?.type), [
    'message.delta',
    'operation',
    'operation',
    'message.completed',
  ]);
  const operationEvents = eventMessages
    .map((item) => item.event)
    .filter((event): event is Extract<LocalAgentRuntimeEvent, { type: 'operation' }> =>
      event.type === 'operation');
  assert.deepEqual(operationEvents.map((event) => event.phase), ['started', 'completed']);
  assert.deepEqual(
    operationEvents.map((event) => [event.operation.kind, event.operation.target]),
    // The completed event inherits the start event's target even though
    // read_file only describes itself via summarizeInput.
    [['local-toolkit.read_file', 'README.md'], ['local-toolkit.read_file', 'README.md']],
  );

  assert.equal(operationEvents.some((event) => 'raw' in event), false);

  const hostedSession = handler.readSessionProjection('user-1');
  assert.ok(hostedSession);
  assert.equal(hostedSession.activeRun, null);
  assert.equal(
    hostedSession.timeline.some((entry) => entry.type === 'operation' && entry.raw !== undefined),
    false,
  );

  let tuiState = createInitialTuiState(createSession({ id: hostedSession.sessionId }));
  tuiState = tuiStateReducer(tuiState, {
    type: 'run.start',
    requestId: 'req-1',
    kind: 'chat',
    message: {
      id: 'message:req-1:user',
      role: 'user',
      text: 'hello',
      requestId: 'req-1',
      source: 'local-input',
    },
    now: 1000,
  });
  for (const envelope of eventMessages) {
    tuiState = tuiStateReducer(tuiState, {
      type: 'event.received',
      event: envelope.event,
      now: 1000,
    });
  }
  assert.deepEqual(tuiState.sessions[hostedSession.sessionId]?.timeline, hostedSession.timeline);
  assert.deepEqual(tuiState.sessions[hostedSession.sessionId]?.activeRun, hostedSession.activeRun);
});

test('LocalAgentAppChatHandler settles projected operations when a run is interrupted', async () => {
  let notifyStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    notifyStarted = resolve;
  });
  const { handler, ws, sent } = createHandler({
    now: () => 1000,
    runChat: async (options) => {
      options.emitToolEvent({
        event: 'on_tool_start',
        name: 'run_shell',
        input: { command: 'npm test' },
      });
      notifyStarted();
      const signal = options.setup.input.signal;
      assert.ok(signal);
      await new Promise<void>((resolve) => {
        signal.addEventListener('abort', () => resolve(), { once: true });
      });
      options.finishInterrupted();
      return { status: 'interrupted', reply: '' };
    },
  });

  const runPromise = handler.handleChatRequest(ws, {
    type: 'chat_request',
    requestId: 'req-interrupt',
    message: 'run tests',
    userId: 'user-1',
  });
  await started;

  handler.handleRunInterrupt(ws, {
    type: 'run.interrupt',
    requestId: 'req-interrupt',
  });
  await runPromise;

  const projection = handler.readSessionProjection('user-1');
  assert.ok(projection);
  assert.equal(projection.activeRun, null);
  const operation = projection.timeline.find((entry) => entry.type === 'operation');
  assert.equal(operation?.type, 'operation');
  assert.equal(operation?.phase, 'interrupted');
  const operationEvents = sent
    .filter((item): item is { type: 'event'; event: LocalAgentRuntimeEvent } =>
      Boolean(item && typeof item === 'object' && (item as { type?: unknown }).type === 'event'))
    .map((item) => item.event)
    .filter((event): event is Extract<LocalAgentRuntimeEvent, { type: 'operation' }> =>
      event.type === 'operation');
  assert.deepEqual(operationEvents.map((event) => event.phase), ['started', 'interrupted']);

  let tuiState = createInitialTuiState(createSession({ id: projection.sessionId }));
  tuiState = tuiStateReducer(tuiState, {
    type: 'run.start',
    requestId: 'req-interrupt',
    kind: 'chat',
    message: {
      id: 'message:req-interrupt:user',
      role: 'user',
      text: 'run tests',
      requestId: 'req-interrupt',
      source: 'local-input',
    },
    now: 1000,
  });
  tuiState = tuiStateReducer(tuiState, {
    type: 'event.received',
    event: operationEvents[0]!,
    now: 1000,
  });
  tuiState = tuiStateReducer(tuiState, {
    type: 'run.interrupting',
    requestId: 'req-interrupt',
  });
  tuiState = tuiStateReducer(tuiState, {
    type: 'event.received',
    event: operationEvents[1]!,
    now: 1000,
  });
  tuiState = tuiStateReducer(tuiState, {
    type: 'run.finish',
    requestId: 'req-interrupt',
  });
  assert.deepEqual(tuiState.sessions[projection.sessionId]?.timeline, projection.timeline);
  assert.deepEqual(tuiState.sessions[projection.sessionId]?.activeRun, projection.activeRun);
});

test('LocalAgentAppChatHandler settles the previous run before projecting replacement input', async () => {
  let notifyFirstStarted!: () => void;
  const firstStarted = new Promise<void>((resolve) => {
    notifyFirstStarted = resolve;
  });
  const { handler, ws, sent } = createHandler({
    now: () => 1000,
    runChat: async (options) => {
      if (options.request.requestId !== 'req-old') {
        return { status: 'completed', reply: 'replacement completed' };
      }
      options.emitToolEvent({
        event: 'on_tool_start',
        name: 'run_shell',
        input: { command: 'long-running' },
      });
      notifyFirstStarted();
      const signal = options.setup.input.signal;
      assert.ok(signal);
      await new Promise<void>((resolve) => {
        signal.addEventListener('abort', () => resolve(), { once: true });
      });
      options.emitEvent({
        type: 'message.delta',
        requestId: 'req-old',
        role: 'assistant',
        text: 'late stale output',
      });
      return { status: 'interrupted', reply: '' };
    },
  });

  const oldRun = handler.handleChatRequest(ws, {
    type: 'chat_request',
    requestId: 'req-old',
    message: 'old request',
    userId: 'user-1',
  });
  await firstStarted;
  await handler.handleChatRequest(ws, {
    type: 'chat_request',
    requestId: 'req-new',
    message: 'new request',
    userId: 'user-1',
  });
  await oldRun;

  const projection = handler.readSessionProjection('user-1');
  assert.ok(projection);
  assert.equal(projection.activeRun, null);
  const operation = projection.timeline.find((entry) => entry.type === 'operation');
  assert.ok(operation && operation.type === 'operation');
  assert.equal(operation.phase, 'interrupted');
  assert.deepEqual(
    projection.timeline
      .filter((entry) => entry.type === 'message' && entry.role === 'user')
      .map((entry) => entry.requestId),
    ['req-old', 'req-new'],
  );
  assert.equal(
    sent.some((item) => JSON.stringify(item).includes('late stale output')),
    false,
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

test('LocalAgentAppChatHandler bounds hosted session projections by recency', async () => {
  const { handler, ws } = createHandler({ maxSessionProjections: 2 });

  for (const userId of ['user-1', 'user-2', 'user-3']) {
    await handler.handleChatRequest(ws, {
      type: 'chat_request',
      requestId: `req-${userId}`,
      message: userId,
      userId,
    });
  }

  assert.equal(handler.readSessionProjection('user-1'), null);
  assert.ok(handler.readSessionProjection('user-2'));
  assert.ok(handler.readSessionProjection('user-3'));
});

test('LocalAgentAppChatHandler retains active projections above the idle retention limit', async () => {
  let notifyFirstStarted!: () => void;
  const firstStarted = new Promise<void>((resolve) => {
    notifyFirstStarted = resolve;
  });
  let notifySecondStarted!: () => void;
  const secondStarted = new Promise<void>((resolve) => {
    notifySecondStarted = resolve;
  });
  let releaseFirst!: () => void;
  const firstReleased = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  let releaseSecond!: () => void;
  const secondReleased = new Promise<void>((resolve) => {
    releaseSecond = resolve;
  });
  const { handler, ws } = createHandler({
    maxSessionProjections: 1,
    isCurrentSocket: () => true,
    runChat: async (options) => {
      options.emitEvent({
        type: 'message.delta',
        requestId: options.request.requestId,
        role: 'assistant',
        text: options.request.requestId,
      });
      if (options.request.requestId === 'req-active-1') {
        notifyFirstStarted();
        await firstReleased;
      } else {
        notifySecondStarted();
        await secondReleased;
      }
      return { status: 'completed', reply: 'done' };
    },
  });
  const secondWs = createFakeWebSocket([]);

  const firstRun = handler.handleChatRequest(ws, {
    type: 'chat_request',
    requestId: 'req-active-1',
    message: 'first',
    userId: 'user-active-1',
  });
  await firstStarted;
  const secondRun = handler.handleChatRequest(secondWs, {
    type: 'chat_request',
    requestId: 'req-active-2',
    message: 'second',
    userId: 'user-active-2',
  });
  await secondStarted;

  assert.equal(handler.readSessionProjection('user-active-1')?.activeRun?.requestId, 'req-active-1');
  assert.equal(handler.readSessionProjection('user-active-2')?.activeRun?.requestId, 'req-active-2');

  releaseFirst();
  releaseSecond();
  await Promise.all([firstRun, secondRun]);
});

test('LocalAgentAppChatHandler keeps runtime error details out of remote state and events', async () => {
  const { handler, ws, sent } = createHandler({
    runChat: async () => {
      throw new Error('secret command failed in /private/workdir');
    },
  });

  await handler.handleChatRequest(ws, {
    type: 'chat_request',
    requestId: 'req-error',
    message: 'fail',
    userId: 'user-1',
  });

  const errorEnvelope = sent.at(-1) as {
    type?: string;
    event?: { type?: string; message?: string };
  };
  assert.equal(errorEnvelope.type, 'event');
  assert.equal(errorEnvelope.event?.type, 'error');
  assert.equal(errorEnvelope.event?.message, 'internal error');
  const projection = handler.readSessionProjection('user-1');
  assert.ok(projection);
  assert.equal(projection.activeRun, null);
  assert.equal(
    projection.timeline.some((entry) =>
      entry.type === 'message' && entry.text.includes('secret command')),
    false,
  );
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

test('LocalAgentAppChatHandler recovers a batch review route from app-chat checkpoint state', async () => {
  const reviews = [
    {
      id: 'review-1',
      schemaVersion: 1,
      view: { kind: 'plain' as const, body: 'Approve first?' },
      options: [{ id: 'approve-1', label: 'Approve', decision: { type: 'approve' as const } }],
    },
    {
      id: 'review-2',
      schemaVersion: 1,
      view: { kind: 'plain' as const, body: 'Approve second?' },
      options: [{ id: 'approve-2', label: 'Approve', decision: { type: 'approve' as const } }],
    },
  ];
  const runRequests: unknown[] = [];
  let stateReads = 0;
  let stateDuringResume: string | undefined;
  let reviewActionDuringResume: string | undefined;
  let fixture: ReturnType<typeof createHandler>;
  fixture = createHandler({
    checkpoint: createCheckpoint([
      'petbot:chat:pet:pet-a:user:user-1',
      'petbot:chat:pet:pet-a:user:user-1',
    ]),
    graphService: {
      async readThreadState(setup: AgentChannelSetup) {
        stateReads += 1;
        assert.equal(setup.input.threadId, 'petbot:chat:pet:pet-a:user:user-1');
        return {
          messages: [],
          pendingHumanReview: {
            interruptId: 'interrupt-recovered',
            review: reviews[0],
            reviews,
          },
          hasPendingContinuation: true,
        };
      },
    } as unknown as ConstructorParameters<typeof LocalAgentAppChatHandler>[0]['graphService'],
    now: () => 1000,
    runChat: async (options) => {
      runRequests.push(options.request);
      const projection = fixture.handler.readSessionProjection('user-1');
      stateDuringResume = projection?.activeRun?.state;
      reviewActionDuringResume = projection?.activeRun?.state === 'waiting_review'
        ? projection.activeRun.reviewAction.actionId
        : undefined;
      return { status: 'completed', reply: 'done after recovery' };
    },
  });

  await fixture.handler.handleHumanReviewResponse(fixture.ws, {
    type: 'human_review_response',
    requestId: 'req-recovered',
    actionId: 'interrupt-recovered',
    reviewId: 'review-2',
    selectedOptionId: 'approve-2',
    decisions: [
      { reviewId: 'review-1', selectedOptionId: 'approve-1' },
      { reviewId: 'review-2', selectedOptionId: 'approve-2' },
    ],
  });

  assert.equal(stateReads, 1);
  assert.deepEqual(runRequests, [{
    kind: 'resume',
    requestId: 'req-recovered',
    resume: {
      'interrupt-recovered': {
        decisions: [
          { reviewId: 'review-1', selectedOptionId: 'approve-1' },
          { reviewId: 'review-2', selectedOptionId: 'approve-2' },
        ],
      },
    },
  }]);
  assert.equal(stateDuringResume, 'waiting_review');
  assert.equal(reviewActionDuringResume, 'interrupt-recovered');
  assert.equal(fixture.handler.readSessionProjection('user-1')?.activeRun, null);

  await fixture.handler.handleHumanReviewResponse(fixture.ws, {
    type: 'human_review_response',
    requestId: 'req-recovered',
    actionId: 'interrupt-recovered',
    reviewId: 'review-2',
    selectedOptionId: 'approve-2',
    decisions: [
      { reviewId: 'review-1', selectedOptionId: 'approve-1' },
      { reviewId: 'review-2', selectedOptionId: 'approve-2' },
    ],
  });

  assert.equal(runRequests.length, 1);
  const duplicateResponse = fixture.sent.at(-1) as { event?: { type?: string } };
  assert.equal(duplicateResponse.event?.type, 'error');
});

test('LocalAgentAppChatHandler waits for review resolution checkpointing before applying an interrupt', async () => {
  const review = {
    id: 'review-order',
    schemaVersion: 1,
    view: { kind: 'plain' as const, body: 'Approve?' },
    options: [{ id: 'approve', label: 'Approve', decision: { type: 'approve' as const } }],
  };
  let notifyReadStarted!: () => void;
  const readStarted = new Promise<void>((resolve) => {
    notifyReadStarted = resolve;
  });
  let releaseRead!: () => void;
  const readReleased = new Promise<void>((resolve) => {
    releaseRead = resolve;
  });
  let runCount = 0;
  const { handler, ws, sent } = createHandler({
    checkpoint: createCheckpoint(['petbot:chat:pet:pet-a:user:user-1']),
    graphService: {
      async readThreadState() {
        notifyReadStarted();
        await readReleased;
        return {
          messages: [],
          pendingHumanReview: {
            interruptId: 'interrupt-order',
            review,
          },
          hasPendingContinuation: true,
        };
      },
    } as unknown as ConstructorParameters<typeof LocalAgentAppChatHandler>[0]['graphService'],
    runChat: async (options) => {
      runCount += 1;
      assert.equal(options.setup.input.signal?.aborted, false);
      options.onResumeCheckpointed?.({ canInterrupt: true });
      assert.equal(options.setup.input.signal?.aborted, true);
      options.finishInterrupted();
      return { status: 'interrupted' };
    },
  });

  const resolution = handler.handleHumanReviewResponse(ws, {
    type: 'human_review_response',
    requestId: 'req-order',
    actionId: 'interrupt-order',
    reviewId: review.id,
    selectedOptionId: 'approve',
  });
  await readStarted;
  handler.handleRunInterrupt(ws, {
    type: 'run.interrupt',
    requestId: 'req-order',
  });
  releaseRead();
  await resolution;

  assert.equal(runCount, 1);
  assert.deepEqual(sent.filter((message) => (
    message as { type?: string }
  ).type !== 'event'), [
    { type: 'interrupting', requestId: 'req-order', message: 'interrupting' },
    { type: 'interrupted', requestId: 'req-order', message: 'interrupted' },
  ]);
});

test('LocalAgentAppChatHandler claims a recovered review by actionId across requestIds', async () => {
  const review = {
    id: 'review-shared-action',
    schemaVersion: 1,
    view: { kind: 'plain' as const, body: 'Approve?' },
    options: [{ id: 'approve', label: 'Approve', decision: { type: 'approve' as const } }],
  };
  let notifyResumeStarted!: () => void;
  const resumeStarted = new Promise<void>((resolve) => {
    notifyResumeStarted = resolve;
  });
  let releaseResume!: () => void;
  const resumeReleased = new Promise<void>((resolve) => {
    releaseResume = resolve;
  });
  let runCount = 0;
  const { handler, ws, sent } = createHandler({
    checkpoint: createCheckpoint(['petbot:chat:pet:pet-a:user:user-1']),
    graphService: {
      async readThreadState() {
        return {
          messages: [],
          pendingHumanReview: {
            interruptId: 'interrupt-shared-action',
            review,
          },
          hasPendingContinuation: true,
        };
      },
    } as unknown as ConstructorParameters<typeof LocalAgentAppChatHandler>[0]['graphService'],
    runChat: async () => {
      runCount += 1;
      notifyResumeStarted();
      await resumeReleased;
      return { status: 'completed', reply: 'done' };
    },
  });
  const response = {
    type: 'human_review_response' as const,
    actionId: 'interrupt-shared-action',
    reviewId: review.id,
    selectedOptionId: 'approve',
  };

  const firstResponse = handler.handleHumanReviewResponse(ws, {
    ...response,
    requestId: 'req-first-envelope',
  });
  await resumeStarted;
  await handler.handleHumanReviewResponse(ws, {
    ...response,
    requestId: 'req-second-envelope',
  });
  releaseResume();
  await firstResponse;

  assert.equal(runCount, 1);
  const duplicate = sent.at(-1) as { requestId?: string; event?: { type?: string } };
  assert.equal(duplicate.requestId, 'req-second-envelope');
  assert.equal(duplicate.event?.type, 'error');
});

test('LocalAgentAppChatHandler retries checkpoint recovery after a failed resume', async () => {
  const review = {
    id: 'review-retry',
    schemaVersion: 1,
    view: { kind: 'plain' as const, body: 'Approve?' },
    options: [{ id: 'approve', label: 'Approve', decision: { type: 'approve' as const } }],
  };
  let runCount = 0;
  let stateReads = 0;
  const { handler, ws } = createHandler({
    checkpoint: createCheckpoint(['petbot:chat:pet:pet-a:user:user-1']),
    graphService: {
      async readThreadState() {
        stateReads += 1;
        return {
          messages: [],
          pendingHumanReview: {
            interruptId: 'interrupt-retry',
            review,
          },
          hasPendingContinuation: true,
        };
      },
    } as unknown as ConstructorParameters<typeof LocalAgentAppChatHandler>[0]['graphService'],
    runChat: async () => {
      runCount += 1;
      if (runCount === 1) {
        throw new Error('transient resume failure');
      }
      return { status: 'completed', reply: 'recovered' };
    },
  });
  const response = {
    type: 'human_review_response' as const,
    requestId: 'req-retry',
    actionId: 'interrupt-retry',
    reviewId: review.id,
    selectedOptionId: 'approve',
  };

  await handler.handleHumanReviewResponse(ws, response);
  await handler.handleHumanReviewResponse(ws, response);

  assert.equal(runCount, 2);
  assert.equal(stateReads, 2);
});

test('LocalAgentAppChatHandler fails closed when a legacy recovery scan is incomplete', async () => {
  const review = {
    id: 'review-incomplete',
    schemaVersion: 1,
    view: { kind: 'plain' as const, body: 'Approve?' },
    options: [{ id: 'approve', label: 'Approve', decision: { type: 'approve' as const } }],
  };
  let runCount = 0;
  const { handler, ws, sent } = createHandler({
    checkpoint: createCheckpoint([
      'petbot:chat:pet:pet-a:user:user-1',
      'petbot:chat:pet:pet-a:user:user-2',
    ]),
    graphService: {
      async readThreadState(setup: AgentChannelSetup) {
        if (setup.input.threadId?.endsWith('user-2')) {
          throw new Error('checkpoint unavailable');
        }
        return {
          messages: [],
          pendingHumanReview: {
            interruptId: 'interrupt-readable',
            review,
          },
          hasPendingContinuation: true,
        };
      },
    } as unknown as ConstructorParameters<typeof LocalAgentAppChatHandler>[0]['graphService'],
    runChat: async () => {
      runCount += 1;
      return { status: 'completed', reply: 'unexpected' };
    },
  });

  await handler.handleHumanReviewResponse(ws, {
    type: 'human_review_response',
    requestId: 'req-incomplete',
    reviewId: review.id,
    selectedOptionId: 'approve',
  });

  assert.equal(runCount, 0);
  const error = sent.at(-1) as { event?: { type?: string } };
  assert.equal(error.event?.type, 'error');
});

test('LocalAgentAppChatHandler fails closed when legacy checkpoint review recovery is ambiguous', async () => {
  const review = {
    id: 'shared-review',
    schemaVersion: 1,
    view: { kind: 'plain' as const, body: 'Approve?' },
    options: [{ id: 'approve', label: 'Approve', decision: { type: 'approve' as const } }],
  };
  let runCount = 0;
  const { handler, ws, sent } = createHandler({
    checkpoint: createCheckpoint([
      'petbot:chat:pet:pet-a:user:user-1',
      'petbot:chat:pet:pet-a:user:user-2',
    ]),
    graphService: {
      async readThreadState() {
        return {
          messages: [],
          pendingHumanReview: {
            interruptId: 'interrupt-by-user',
            review,
          },
          hasPendingContinuation: true,
        };
      },
    } as unknown as ConstructorParameters<typeof LocalAgentAppChatHandler>[0]['graphService'],
    runChat: async () => {
      runCount += 1;
      return { status: 'completed', reply: 'unexpected' };
    },
  });

  await handler.handleHumanReviewResponse(ws, {
    type: 'human_review_response',
    requestId: 'req-legacy',
    reviewId: 'shared-review',
    selectedOptionId: 'approve',
  });

  assert.equal(runCount, 0);
  const last = sent.at(-1) as { event?: { type?: string; message?: string } };
  assert.equal(last.event?.type, 'error');
  assert.match(last.event?.message ?? '', /已关闭|不存在/);
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
