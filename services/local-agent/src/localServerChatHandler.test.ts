import assert from 'node:assert/strict';
import test from 'node:test';
import { projectHumanReviewRequest } from '@pinpawo/pet-agent';
import { isToolProtocolHistoryError, LocalServerChatHandler } from './localServerChatHandler';
import { InflightRequestController } from './inflightRequestController';
import type { LocalServerPeer } from './localServerPeer';

function createFakePeer(
  sent: unknown[] = [],
  isConnected: () => boolean = () => true,
): LocalServerPeer {
  return {
    isConnected,
    send: (message) => {
      sent.push(message);
      return true;
    },
  };
}

test('isToolProtocolHistoryError recognizes LangGraph tool history protocol failures', () => {
  assert.equal(isToolProtocolHistoryError(new Error('INVALID_TOOL_RESULTS')), true);
  assert.equal(isToolProtocolHistoryError(new Error("An assistant message with 'tool_calls' must be followed by tool messages")), true);
  assert.equal(isToolProtocolHistoryError('insufficient tool messages following tool_calls message'), true);
  assert.equal(isToolProtocolHistoryError(new Error('ordinary model error')), false);
});

test('local server forwards structured local attachments to the chat session', async () => {
  const peer = createFakePeer();
  let receivedRequest: unknown;
  const handler = new LocalServerChatHandler({
    graphService: {} as never,
    tuiSessions: {
      getChatThreadId: () => 'thread-x',
      buildChatSetup: () => ({
        graphKey: 'test',
        graphConfig: {},
        input: { messages: [] },
      }),
      refreshActiveSessionSummary: async () => undefined,
    } as never,
    inflightRequests: new InflightRequestController({
      emitOperation: () => undefined,
      sendControl: () => undefined,
    }),
    loadContext: async () => ({} as never),
    runChat: async (options) => {
      receivedRequest = options.request;
      return { status: 'completed', reply: 'done' };
    },
  });

  await handler.handleChatRequest(peer, {
    type: 'chat_request',
    requestId: 'request-1',
    message: 'inspect this',
    attachments: [{
      id: 'attachment-1',
      source: 'local-path',
      kind: 'directory',
      path: '/tmp/project',
      name: 'project',
    }],
  }, { actorId: 'pet-1' } as never);

  assert.deepEqual(receivedRequest, {
    kind: 'user_message',
    requestId: 'request-1',
    message: 'inspect this',
    attachments: [{
      id: 'attachment-1',
      source: 'local-path',
      kind: 'directory',
      path: '/tmp/project',
      name: 'project',
    }],
  });
});

test('replacement request waits for the previous thread invocation to settle', async () => {
  const sent: unknown[] = [];
  const controls: unknown[] = [];
  const peer = createFakePeer(sent);
  let notifyFirstStarted!: () => void;
  const firstStarted = new Promise<void>((resolve) => {
    notifyFirstStarted = resolve;
  });
  let notifyFirstAborted!: () => void;
  const firstAborted = new Promise<void>((resolve) => {
    notifyFirstAborted = resolve;
  });
  let releaseFirst!: () => void;
  const firstReleased = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  let replacementStarted = false;
  const handler = new LocalServerChatHandler({
    graphService: {} as never,
    tuiSessions: {
      getChatThreadId: () => 'thread-x',
      buildChatSetup: () => ({
        graphKey: 'test',
        graphConfig: {},
        input: { messages: [] },
      }),
      refreshActiveSessionSummary: async () => undefined,
    } as never,
    inflightRequests: new InflightRequestController({
      emitOperation: () => undefined,
      sendControl: (_peer, message) => {
        controls.push(message);
      },
    }),
    loadContext: async () => ({} as never),
    runChat: async (options) => {
      if (options.request.requestId !== 'req-old') {
        replacementStarted = true;
        return { status: 'completed', reply: 'replacement completed' };
      }
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
      notifyFirstAborted();
      await firstReleased;
      return { status: 'interrupted', reply: '' };
    },
  });
  const deps = { actorId: 'pet-1' } as never;

  const oldRun = handler.handleChatRequest(peer, {
    type: 'chat_request',
    requestId: 'req-old',
    message: 'old request',
  }, deps);
  await firstStarted;
  const replacementRun = handler.handleChatRequest(peer, {
    type: 'chat_request',
    requestId: 'req-new',
    message: 'new request',
  }, deps);
  await firstAborted;
  assert.equal(replacementStarted, false);
  assert.equal(
    sent.some((item) => JSON.stringify(item).includes('late stale output')),
    false,
  );

  releaseFirst();
  await Promise.all([oldRun, replacementRun]);
  assert.equal(replacementStarted, true);
  assert.deepEqual(controls, [{
    type: 'interrupted',
    requestId: 'req-old',
    message: 'interrupted',
  }]);
});

test('run interrupt waits until the review resolution is checkpointed', async () => {
  const controls: unknown[] = [];
  let runCount = 0;
  const fakePeer = createFakePeer();
  const inflightRequests = new InflightRequestController<LocalServerPeer>({
    emitOperation: () => undefined,
    sendControl: (_peer, message) => {
      controls.push(message);
    },
  });
  const handler = new LocalServerChatHandler({
    graphService: {} as never,
    tuiSessions: {
      getActiveSessionId: () => 'sess-active',
      getChatThreadId: () => 'thread-x',
      readActivePendingReview: async () => null,
      buildChatSetup: () => ({
        graphKey: 'test',
        graphConfig: {},
        input: { messages: [] },
      }),
    } as never,
    inflightRequests,
    loadContext: async () => ({} as never),
    runChat: async (options) => {
      runCount += 1;
      assert.equal(options.setup.input.signal?.aborted, false);
      options.onResumeCheckpointed?.({ canInterrupt: true });
      assert.equal(options.setup.input.signal?.aborted, true);
      options.finishInterrupted();
      return { status: 'interrupted' };
    },
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (handler as any).recordReviewActionRoute({
    type: 'human_review.requested',
    interruptId: 'interrupt-1',
    requestId: 'req-1',
    review: {
      id: 'review-current',
      schemaVersion: 1,
      view: { kind: 'plain', body: 'Approve?' },
      options: [{ id: 'approve', label: 'Approve', decision: { type: 'approve' } }],
    },
  }, { actorId: 'pet-1' });

  const resolution = handler.handleHumanReviewResponse(fakePeer, {
    type: 'human_review_response',
    requestId: 'req-1',
    actionId: 'interrupt-1',
    reviewId: 'review-current',
    selectedOptionId: 'approve',
  }, { actorId: 'pet-1' } as never);
  assert.equal(await handler.handleRunInterrupt(fakePeer, {
    type: 'run.interrupt',
    requestId: 'req-1',
  }, { actorId: 'pet-1' } as never), null);

  await resolution;

  assert.equal(runCount, 1);
  assert.deepEqual(controls, [
    { type: 'interrupting', requestId: 'req-1', message: 'interrupting' },
    { type: 'interrupted', requestId: 'req-1', message: 'interrupted' },
  ]);
});

test('review cancellation automatically interrupts at the first resolved checkpoint', async () => {
  const controls: unknown[] = [];
  const fakePeer = createFakePeer();
  const inflightRequests = new InflightRequestController<LocalServerPeer>({
    emitOperation: () => undefined,
    sendControl: (_peer, message) => {
      controls.push(message);
    },
  });
  const handler = new LocalServerChatHandler({
    graphService: {} as never,
    tuiSessions: {
      getActiveSessionId: () => 'sess-active',
      getChatThreadId: () => 'thread-x',
      readActivePendingReview: async () => null,
      buildChatSetup: () => ({
        graphKey: 'test',
        graphConfig: {},
        input: { messages: [] },
      }),
    } as never,
    inflightRequests,
    loadContext: async () => ({} as never),
    runChat: async (options) => {
      assert.equal(options.interruptOnSettledResumeCheckpoint, true);
      assert.deepEqual(options.request, {
        kind: 'resume',
        requestId: 'req-1',
        resume: {
          'interrupt-1': {
            action: 'interrupt_run',
          },
        },
      });
      assert.equal(options.setup.input.signal?.aborted, false);
      options.onResumeCheckpointed?.({ canInterrupt: true });
      assert.equal(options.setup.input.signal?.aborted, true);
      options.finishInterrupted();
      return { status: 'interrupted' };
    },
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (handler as any).recordReviewActionRoute({
    type: 'human_review.requested',
    interruptId: 'interrupt-1',
    requestId: 'req-1',
    review: {
      id: 'review-current',
      schemaVersion: 1,
      view: { kind: 'plain', body: 'Approve?' },
      options: [{ id: 'approve', label: 'Approve', decision: { type: 'approve' } }],
    },
  }, { actorId: 'pet-1' });

  await handler.handleReviewCancel(fakePeer, {
    type: 'review.cancel',
    requestId: 'req-1',
    actionId: 'interrupt-1',
  }, { actorId: 'pet-1' } as never);

  assert.deepEqual(controls, [
    { type: 'interrupting', requestId: 'req-1', message: 'interrupting' },
    { type: 'interrupted', requestId: 'req-1', message: 'interrupted' },
  ]);
});

test('run interrupt cancels a review that became pending before the client observed it', async () => {
  const controls: unknown[] = [];
  const requests: unknown[] = [];
  const fakePeer = createFakePeer();
  const handler = new LocalServerChatHandler({
    graphService: {} as never,
    tuiSessions: {
      getActiveSessionId: () => 'sess-active',
      getChatThreadId: () => 'thread-x',
      readActivePendingReview: async () => null,
      buildChatSetup: () => ({
        graphKey: 'test',
        graphConfig: {},
        input: { messages: [] },
      }),
    } as never,
    inflightRequests: new InflightRequestController<LocalServerPeer>({
      emitOperation: () => undefined,
      sendControl: (_peer, message) => controls.push(message),
    }),
    loadContext: async () => ({} as never),
    runChat: async (options) => {
      requests.push(options.request);
      assert.equal(options.interruptOnSettledResumeCheckpoint, true);
      options.onResumeCheckpointed?.({ canInterrupt: true });
      options.finishInterrupted();
      return { status: 'interrupted' };
    },
  });
  // Simulate the server registering waiting_review immediately before the TUI
  // sends the ordinary run.interrupt it chose from its stale thinking state.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (handler as any).recordReviewActionRoute({
    type: 'human_review.requested',
    interruptId: 'interrupt-race',
    requestId: 'req-race',
    review: {
      id: 'review-race',
      schemaVersion: 1,
      view: { kind: 'plain', body: 'Approve?' },
      options: [{ id: 'approve', label: 'Approve', decision: { type: 'approve' } }],
    },
  }, { actorId: 'pet-1' });

  const result = await handler.handleRunInterrupt(fakePeer, {
    type: 'run.interrupt',
    requestId: 'req-race',
  }, { actorId: 'pet-1' } as never);

  assert.equal(result, null);
  assert.deepEqual(requests, [{
    kind: 'resume',
    requestId: 'req-race',
    resume: {
      'interrupt-race': { action: 'interrupt_run' },
    },
  }]);
  assert.deepEqual(controls, [
    { type: 'interrupting', requestId: 'req-race', message: 'interrupting' },
    { type: 'interrupted', requestId: 'req-race', message: 'interrupted' },
  ]);
});

test('handleHumanReviewResponse rejects stale canonical reviewId before forwarding', async () => {
  const handleChatCalls: unknown[] = [];
  const sentEvents: unknown[] = [];
  const fakePeer = createFakePeer(sentEvents);
  const tuiSessions = {
    getActiveSessionId: () => 'sess-active',
    getChatThreadId: () => 'thread-x',
    readActivePendingReview: async () => ({
      sessionId: 'sess-active',
      interruptId: 'interrupt-1',
      review: {
        id: 'review-current',
        schemaVersion: 1,
        view: { kind: 'plain', body: 'Approve?' },
        options: [{ id: 'approve', label: 'Approve', decision: { type: 'approve' } }],
      },
    }),
  } as never;
  const handler = new LocalServerChatHandler({
    graphService: {} as never,
    tuiSessions,
    inflightRequests: new InflightRequestController({
      emitOperation: () => {},
      sendControl: () => {},
    }),
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (handler as any).runChatRequest = async (...args: unknown[]) => {
    handleChatCalls.push(args);
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (handler as any).recordReviewActionRoute({
    type: 'human_review.requested',
    interruptId: 'interrupt-1',
    requestId: 'req-1',
    review: {
      id: 'review-current',
      schemaVersion: 1,
      view: { kind: 'plain', body: 'Approve?' },
      options: [{ id: 'approve', label: 'Approve', decision: { type: 'approve' } }],
    },
  }, { actorId: 'pet-1' });

  await handler.handleHumanReviewResponse(
    fakePeer,
    {
      type: 'human_review_response',
      requestId: 'req-1',
      reviewId: 'review-old',
      selectedOptionId: 'approve',
    },
    { actorId: 'pet-1' } as never,
  );

  assert.equal(handleChatCalls.length, 0);
  assert.equal(sentEvents.length, 1);
  const event = sentEvents[0] as {
    type: string;
    event?: { type: string; requestId: string; message: string; code?: string };
  };
  assert.equal(event.type, 'event');
  assert.equal(event.event?.type, 'error');
  assert.equal(event.event?.requestId, 'req-1');
  assert.match(event.event?.message ?? '', /过期/);
  assert.equal(event.event?.code, 'review_stale');
});

test('handleHumanReviewResponse consumes matching canonical review route once', async () => {
  const handleChatCalls: unknown[] = [];
  const sentEvents: unknown[] = [];
  const fakePeer = createFakePeer(sentEvents);
  const tuiSessions = {
    getActiveSessionId: () => 'sess-active',
    getChatThreadId: () => 'thread-x',
    readActivePendingReview: async () => null,
  } as never;
  const handler = new LocalServerChatHandler({
    graphService: {} as never,
    tuiSessions,
    inflightRequests: new InflightRequestController({
      emitOperation: () => {},
      sendControl: () => {},
    }),
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (handler as any).runChatRequest = async (...args: unknown[]) => {
    handleChatCalls.push(args);
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (handler as any).recordReviewActionRoute({
    type: 'human_review.requested',
    interruptId: 'interrupt-1',
    requestId: 'req-1',
    review: {
      id: 'review-current',
      schemaVersion: 1,
      view: { kind: 'plain', body: 'Approve?' },
      options: [{ id: 'approve', label: 'Approve', decision: { type: 'approve' } }],
    },
  }, { actorId: 'pet-1' });

  const message = {
    type: 'human_review_response' as const,
    requestId: 'req-1',
    reviewId: 'review-current',
    selectedOptionId: 'approve',
  };
  await handler.handleHumanReviewResponse(fakePeer, message, { actorId: 'pet-1' } as never);
  await handler.handleHumanReviewResponse(fakePeer, message, { actorId: 'pet-1' } as never);

  assert.equal(handleChatCalls.length, 1, 'matching review response should be forwarded once');
  const forwardedMessage = (handleChatCalls[0] as unknown[])[1] as {
    kind: string;
    requestId: string;
    resume?: unknown;
  };
  const forwardedSource = (handleChatCalls[0] as unknown[])[3];
  assert.deepEqual(forwardedMessage, {
    kind: 'resume',
    requestId: 'req-1',
    resume: {
      'interrupt-1': {
        decisions: [{
          reviewId: 'review-current',
          selectedOptionId: 'approve',
        }],
      },
    },
  });
  assert.deepEqual(forwardedSource, {
    type: 'human_review_response',
    reviewId: 'review-current',
    selectedOptionId: 'approve',
    decisionCount: 1,
  });
  assert.equal(sentEvents.length, 1, 'second response should be rejected after route is consumed');
  const event = sentEvents[0] as { type: string; event?: { type: string; message: string; code?: string } };
  assert.equal(event.type, 'event');
  assert.equal(event.event?.type, 'error');
  assert.match(event.event?.message ?? '', /已关闭|不存在/);
  assert.equal(event.event?.code, 'review_closed');

  await handler.handleReviewCancel(
    fakePeer,
    {
      type: 'review.cancel',
      requestId: 'req-1',
      actionId: 'interrupt-1',
    },
    { actorId: 'pet-1' } as never,
  );
  assert.equal((sentEvents.at(-1) as { event?: { code?: string } }).event?.code, 'review_closed');
});

test('handleHumanReviewResponse keeps single-review review as batch resume shape', async () => {
  const handleChatCalls: unknown[] = [];
  const sentEvents: unknown[] = [];
  const fakePeer = createFakePeer(sentEvents);
  const review = {
    id: 'review-current',
    schemaVersion: 1,
    view: { kind: 'plain' as const, body: 'Approve?' },
    options: [{ id: 'approve', label: 'Approve', decision: { type: 'approve' as const } }],
  };
  const handler = new LocalServerChatHandler({
    graphService: {} as never,
    tuiSessions: {
      getActiveSessionId: () => 'sess-active',
      getChatThreadId: () => 'thread-x',
      readActivePendingReview: async () => null,
    } as never,
    inflightRequests: new InflightRequestController({
      emitOperation: () => {},
      sendControl: () => {},
    }),
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (handler as any).runChatRequest = async (...args: unknown[]) => {
    handleChatCalls.push(args);
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (handler as any).recordReviewActionRoute({
    type: 'human_review.requested',
    interruptId: 'interrupt-1',
    requestId: 'req-1',
    review,
    reviews: [review],
  }, { actorId: 'pet-1' });

  await handler.handleHumanReviewResponse(
    fakePeer,
    {
      type: 'human_review_response',
      requestId: 'req-1',
      reviewId: 'review-current',
      selectedOptionId: 'approve',
      decisions: [{ reviewId: 'review-current', selectedOptionId: 'approve' }],
    },
    { actorId: 'pet-1' } as never,
  );

  assert.equal(handleChatCalls.length, 1);
  const forwardedMessage = (handleChatCalls[0] as unknown[])[1] as {
    kind: string;
    requestId: string;
    resume?: unknown;
  };
  const forwardedSource = (handleChatCalls[0] as unknown[])[3];
  assert.deepEqual(forwardedMessage, {
    kind: 'resume',
    requestId: 'req-1',
    resume: {
      'interrupt-1': {
        decisions: [{ reviewId: 'review-current', selectedOptionId: 'approve' }],
      },
    },
  });
  assert.deepEqual(forwardedSource, {
    type: 'human_review_response',
    reviewId: 'review-current',
    selectedOptionId: 'approve',
    decisionCount: 1,
  });
});

test('handleHumanReviewResponse recovers missing route from active checkpoint review', async () => {
  const handleChatCalls: unknown[] = [];
  const sentEvents: unknown[] = [];
  const fakePeer = createFakePeer(sentEvents);
  const handler = new LocalServerChatHandler({
    graphService: {} as never,
    tuiSessions: {
      getActiveSessionId: () => 'sess-active',
      getChatThreadId: () => 'thread-x',
      readActivePendingReview: async () => ({
        sessionId: 'sess-active',
        interruptId: 'interrupt-1',
        review: {
          id: 'review-current',
          schemaVersion: 1,
          view: { kind: 'plain', body: 'Approve?' },
          options: [{ id: 'approve', label: 'Approve', decision: { type: 'approve' } }],
        },
      }),
    } as never,
    inflightRequests: new InflightRequestController({
      emitOperation: () => {},
      sendControl: () => {},
    }),
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (handler as any).runChatRequest = async (...args: unknown[]) => {
    handleChatCalls.push(args);
  };

  await handler.handleHumanReviewResponse(
    fakePeer,
    {
      type: 'human_review_response',
      requestId: 'req-1',
      reviewId: 'review-current',
      selectedOptionId: 'approve',
    },
    { actorId: 'pet-1' } as never,
  );

  assert.equal(sentEvents.length, 0);
  assert.equal(handleChatCalls.length, 1);
  const forwardedMessage = (handleChatCalls[0] as unknown[])[1] as {
    kind: string;
    requestId: string;
    resume?: unknown;
  };
  assert.deepEqual(forwardedMessage, {
    kind: 'resume',
    requestId: 'req-1',
    resume: {
      'interrupt-1': {
        decisions: [{
          reviewId: 'review-current',
          selectedOptionId: 'approve',
        }],
      },
    },
  });
});

test('handleHumanReviewResponse releases a recovered review when its peer disconnects', async () => {
  let connected = false;
  const handleChatCalls: unknown[] = [];
  const fakePeer = createFakePeer([], () => connected);
  const handler = new LocalServerChatHandler({
    graphService: {} as never,
    tuiSessions: {
      getActiveSessionId: () => 'sess-active',
      getChatThreadId: () => 'thread-x',
      readActivePendingReview: async () => ({
        sessionId: 'sess-active',
        interruptId: 'interrupt-1',
        review: {
          id: 'review-current',
          schemaVersion: 1,
          view: { kind: 'plain', body: 'Approve?' },
          options: [{ id: 'approve', label: 'Approve', decision: { type: 'approve' } }],
        },
      }),
    } as never,
    inflightRequests: new InflightRequestController({
      emitOperation: () => {},
      sendControl: () => {},
    }),
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (handler as any).runChatRequest = async (...args: unknown[]) => {
    handleChatCalls.push(args);
  };
  const message = {
    type: 'human_review_response' as const,
    requestId: 'req-1',
    reviewId: 'review-current',
    selectedOptionId: 'approve',
  };

  await handler.handleHumanReviewResponse(fakePeer, message, { actorId: 'pet-1' } as never);
  assert.equal(handleChatCalls.length, 0);

  connected = true;
  await handler.handleHumanReviewResponse(fakePeer, message, { actorId: 'pet-1' } as never);
  assert.equal(handleChatCalls.length, 1);
});

test('buildReviewActionSnapshot exposes routeable review action request ids', () => {
  const review = {
    id: 'review-current',
    schemaVersion: 1,
    view: { kind: 'plain' as const, body: 'Approve?' },
    options: [{ id: 'approve', label: 'Approve', decision: { type: 'approve' as const } }],
  };
  const handler = new LocalServerChatHandler({
    graphService: {} as never,
    tuiSessions: {
      getActiveSessionId: () => 'sess-active',
      getChatThreadId: () => 'thread-x',
      readActivePendingReview: async () => ({
        sessionId: 'sess-active',
        review,
      }),
    } as never,
    inflightRequests: new InflightRequestController({
      emitOperation: () => {},
      sendControl: () => {},
    }),
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (handler as any).recordReviewActionRoute({
    type: 'human_review.requested',
    interruptId: 'interrupt-1',
    requestId: 'req-existing',
    review,
    actor: { petId: 'pet-a' },
  }, { actorId: 'pet-1' });

  assert.deepEqual(handler.buildReviewActionSnapshot({ actorId: 'pet-1' } as never, null), {
    requestId: 'interrupt-1',
    sessionId: 'sess-active',
    reviewAction: {
      actionId: 'interrupt-1',
      reviews: [projectHumanReviewRequest(review)],
    },
    actor: { petId: 'pet-a' },
  });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (handler as any).reviewResolutions.clear();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (handler as any).recordReviewActionRoute({
    type: 'human_review.requested',
    interruptId: 'interrupt-1',
    requestId: 'req-action',
    review,
    reviews: [review],
  }, { actorId: 'pet-1' });

  assert.deepEqual(handler.buildReviewActionSnapshot({ actorId: 'pet-1' } as never, null), {
    requestId: 'interrupt-1',
    sessionId: 'sess-active',
    reviewAction: {
      actionId: 'interrupt-1',
      reviews: [projectHumanReviewRequest(review)],
    },
  });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (handler as any).reviewResolutions.clear();
  assert.deepEqual(handler.buildReviewActionSnapshot({ actorId: 'pet-1' } as never, {
    sessionId: 'sess-active',
    interruptId: 'interrupt-1',
    review,
  }), {
    requestId: 'interrupt-1',
    sessionId: 'sess-active',
    reviewAction: {
      actionId: 'interrupt-1',
      reviews: [projectHumanReviewRequest(review)],
    },
  });
});

test('handleReviewCancel resumes pending review with run interruption control', async () => {
  const handleChatCalls: unknown[] = [];
  const sentEvents: unknown[] = [];
  const fakePeer = createFakePeer(sentEvents);
  const handler = new LocalServerChatHandler({
    graphService: {} as never,
    tuiSessions: {
      getActiveSessionId: () => 'sess-active',
      getChatThreadId: () => 'thread-x',
      readActivePendingReview: async () => ({
        sessionId: 'sess-active',
        interruptId: 'interrupt-1',
        review: {
          id: 'review-current',
          schemaVersion: 1,
          view: { kind: 'plain', body: 'Approve?' },
          options: [
            { id: 'approve', label: 'Approve', decision: { type: 'approve' } },
            { id: 'reject', label: 'Reject', decision: { type: 'reject' } },
          ],
        },
      }),
    } as never,
    inflightRequests: new InflightRequestController({
      emitOperation: () => {},
      sendControl: () => {},
    }),
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (handler as any).runChatRequest = async (...args: unknown[]) => {
    handleChatCalls.push(args);
    return 'completed';
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (handler as any).recordReviewActionRoute({
    type: 'human_review.requested',
    interruptId: 'interrupt-1',
    requestId: 'req-1',
    review: {
      id: 'review-current',
      schemaVersion: 1,
      view: { kind: 'plain', body: 'Approve?' },
      options: [
        { id: 'approve', label: 'Approve', decision: { type: 'approve' } },
        { id: 'reject', label: 'Reject', decision: { type: 'reject' } },
      ],
    },
  }, { actorId: 'pet-1' });

  await handler.handleReviewCancel(
    fakePeer,
    {
      type: 'review.cancel',
      requestId: 'req-1',
      actionId: 'interrupt-1',
    },
    { actorId: 'pet-1' } as never,
  );

  assert.equal(sentEvents.length, 0);
  assert.equal(handleChatCalls.length, 1);
  const forwardedMessage = (handleChatCalls[0] as unknown[])[1] as {
    kind: string;
    requestId: string;
    resume?: unknown;
  };
  const forwardedSource = (handleChatCalls[0] as unknown[])[3];
  assert.deepEqual(forwardedMessage, {
    kind: 'resume',
    requestId: 'req-1',
    resume: {
      'interrupt-1': {
        action: 'interrupt_run',
      },
    },
  });
  assert.deepEqual(forwardedSource, {
    type: 'review.cancel',
    reviewId: 'review-current',
    decisionCount: 0,
  });

  await handler.handleHumanReviewResponse(
    fakePeer,
    {
      type: 'human_review_response',
      requestId: 'req-1',
      reviewId: 'review-current',
      selectedOptionId: 'approve',
    },
    { actorId: 'pet-1' } as never,
  );

  assert.equal(handleChatCalls.length, 1, 'pending review route should be consumed by interrupt');
  assert.equal(sentEvents.length, 1);
  const event = sentEvents[0] as { type: string; event?: { type: string; message: string; code?: string } };
  assert.equal(event.type, 'event');
  assert.equal(event.event?.type, 'error');
  assert.match(event.event?.message ?? '', /已关闭|不存在/);
  assert.equal(event.event?.code, 'review_closed');
});

test('handleReviewCancel recovers missing route from active checkpoint review', async () => {
  const handleChatCalls: unknown[] = [];
  const sentEvents: unknown[] = [];
  const fakePeer = createFakePeer(sentEvents);
  const handler = new LocalServerChatHandler({
    graphService: {} as never,
    tuiSessions: {
      getActiveSessionId: () => 'sess-active',
      getChatThreadId: () => 'thread-x',
      readActivePendingReview: async () => ({
        sessionId: 'sess-active',
        interruptId: 'interrupt-1',
        review: {
          id: 'review-current',
          schemaVersion: 1,
          view: { kind: 'plain', body: 'Approve?' },
          options: [
            { id: 'approve', label: 'Approve', decision: { type: 'approve' } },
            { id: 'reject', label: 'Reject', decision: { type: 'reject' } },
          ],
        },
      }),
    } as never,
    inflightRequests: new InflightRequestController({
      emitOperation: () => {},
      sendControl: () => {},
    }),
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (handler as any).runChatRequest = async (...args: unknown[]) => {
    handleChatCalls.push(args);
  };

  await handler.handleReviewCancel(
    fakePeer,
    {
      type: 'review.cancel',
      requestId: 'req-1',
      actionId: 'interrupt-1',
    },
    { actorId: 'pet-1' } as never,
  );

  assert.equal(sentEvents.length, 0);
  assert.equal(handleChatCalls.length, 1);
  const forwardedMessage = (handleChatCalls[0] as unknown[])[1] as {
    kind: string;
    requestId: string;
    resume?: unknown;
  };
  const forwardedSource = (handleChatCalls[0] as unknown[])[3];
  assert.deepEqual(forwardedMessage, {
    kind: 'resume',
    requestId: 'req-1',
    resume: {
      'interrupt-1': {
        action: 'interrupt_run',
      },
    },
  });
  assert.deepEqual(forwardedSource, {
    type: 'review.cancel',
    reviewId: 'review-current',
    decisionCount: 0,
  });
});

test('handleReviewCancel interrupts an approve-only pending review', async () => {
  const handleChatCalls: unknown[] = [];
  const sentEvents: unknown[] = [];
  const fakePeer = createFakePeer(sentEvents);
  const handler = new LocalServerChatHandler({
    graphService: {} as never,
    tuiSessions: {
      getActiveSessionId: () => 'sess-active',
      getChatThreadId: () => 'thread-x',
    } as never,
    inflightRequests: new InflightRequestController({
      emitOperation: () => {},
      sendControl: () => {},
    }),
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (handler as any).runChatRequest = async (...args: unknown[]) => {
    handleChatCalls.push(args);
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (handler as any).recordReviewActionRoute({
    type: 'human_review.requested',
    interruptId: 'interrupt-1',
    requestId: 'req-1',
    prompt: 'Approve?',
    review: {
      id: 'review-current',
      schemaVersion: 1,
      view: { kind: 'plain', body: 'Approve?' },
      options: [{ id: 'approve', label: 'Approve', decision: { type: 'approve' } }],
    },
  }, { actorId: 'pet-1' });

  await handler.handleReviewCancel(
    fakePeer,
    {
      type: 'review.cancel',
      requestId: 'req-1',
      actionId: 'interrupt-1',
    },
    { actorId: 'pet-1' } as never,
  );

  assert.equal(handleChatCalls.length, 1);
  assert.equal(sentEvents.length, 0);
  const forwardedMessage = (handleChatCalls[0] as unknown[])[1];
  assert.deepEqual(forwardedMessage, {
    kind: 'resume',
    requestId: 'req-1',
    resume: {
      'interrupt-1': {
        action: 'interrupt_run',
      },
    },
  });

  await handler.handleHumanReviewResponse(
    fakePeer,
    {
      type: 'human_review_response',
      requestId: 'req-1',
      reviewId: 'review-current',
      selectedOptionId: 'approve',
    },
    { actorId: 'pet-1' } as never,
  );

  assert.equal(handleChatCalls.length, 1, 'cancelled review route should be consumed');
});

test('handleHumanReviewResponse forwards canonical selected option without resolving it', async () => {
  const handleChatCalls: unknown[] = [];
  const sentEvents: unknown[] = [];
  const fakePeer = createFakePeer(sentEvents);
  const tuiSessions = {
    getActiveSessionId: () => 'sess-active',
    getChatThreadId: () => 'thread-x',
  } as never;
  const handler = new LocalServerChatHandler({
    graphService: {} as never,
    tuiSessions,
    inflightRequests: new InflightRequestController({
      emitOperation: () => {},
      sendControl: () => {},
    }),
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (handler as any).runChatRequest = async (...args: unknown[]) => {
    handleChatCalls.push(args);
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (handler as any).recordReviewActionRoute({
    type: 'human_review.requested',
    interruptId: 'interrupt-1',
    requestId: 'req-1',
    review: {
      id: 'review-current',
      schemaVersion: 1,
      view: { kind: 'plain', body: 'Need input' },
      options: [{
        id: 'respond',
        label: 'Respond',
        input: { kind: 'text', key: 'message', required: true, multiline: true },
        decision: { type: 'respond', messageInputKey: 'message' },
      }],
    },
  }, { actorId: 'pet-1' });

  await handler.handleHumanReviewResponse(
    fakePeer,
    {
      type: 'human_review_response',
      requestId: 'req-1',
      reviewId: 'review-current',
      selectedOptionId: 'respond',
      input: { message: '请先解释风险' },
    },
    { actorId: 'pet-1' } as never,
  );

  assert.equal(sentEvents.length, 0);
  assert.equal(handleChatCalls.length, 1);
  const forwardedMessage = (handleChatCalls[0] as unknown[])[1] as {
    kind: string;
    resume?: unknown;
  };
  const forwardedSource = (handleChatCalls[0] as unknown[])[3];
  assert.deepEqual(forwardedMessage, {
    kind: 'resume',
    requestId: 'req-1',
    resume: {
      'interrupt-1': {
        decisions: [{
          reviewId: 'review-current',
          selectedOptionId: 'respond',
          input: { message: '请先解释风险' },
        }],
      },
    },
  });
  assert.deepEqual(forwardedSource, {
    type: 'human_review_response',
    reviewId: 'review-current',
    selectedOptionId: 'respond',
    decisionCount: 1,
  });
});

test('handleHumanReviewResponse rejects canonical review response from a different active session', async () => {
  const handleChatCalls: unknown[] = [];
  const sentEvents: unknown[] = [];
  let activeSessionId = 'sess-origin';
  const fakePeer = createFakePeer(sentEvents);
  const tuiSessions = {
    getActiveSessionId: () => activeSessionId,
    getChatThreadId: () => 'thread-x',
  } as never;
  const handler = new LocalServerChatHandler({
    graphService: {} as never,
    tuiSessions,
    inflightRequests: new InflightRequestController({
      emitOperation: () => {},
      sendControl: () => {},
    }),
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (handler as any).runChatRequest = async (...args: unknown[]) => {
    handleChatCalls.push(args);
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (handler as any).recordReviewActionRoute({
    type: 'human_review.requested',
    interruptId: 'interrupt-1',
    requestId: 'req-1',
    review: {
      id: 'review-current',
      schemaVersion: 1,
      view: { kind: 'plain', body: 'Approve?' },
      options: [{ id: 'approve', label: 'Approve', decision: { type: 'approve' } }],
    },
  }, { actorId: 'pet-1' });
  activeSessionId = 'sess-other';

  await handler.handleHumanReviewResponse(
    fakePeer,
    {
      type: 'human_review_response',
      requestId: 'req-1',
      reviewId: 'review-current',
      selectedOptionId: 'approve',
    },
    { actorId: 'pet-1' } as never,
  );

  assert.equal(handleChatCalls.length, 0);
  assert.equal(sentEvents.length, 1);
  const event = sentEvents[0] as { type: string; event?: { type: string; message: string; code?: string } };
  assert.equal(event.type, 'event');
  assert.equal(event.event?.type, 'error');
  assert.match(event.event?.message ?? '', /发起该 review 的会话/);
  assert.equal(event.event?.code, 'review_wrong_session');
});

test('handleHumanReviewResponse forwards effect-bearing options without local authorization side effects', async () => {
  const handleChatCalls: unknown[] = [];
  const sentEvents: unknown[] = [];
  const updateStateCalls: unknown[] = [];
  const fakePeer = createFakePeer(sentEvents);

  const handler = new LocalServerChatHandler({
    graphService: {
      updateState: async (...args: unknown[]) => {
        updateStateCalls.push(args);
      },
    } as never,
    tuiSessions: {
      getActiveSessionId: () => 'sess-active',
      getChatThreadId: () => 'thread-x',
    } as never,
    inflightRequests: new InflightRequestController({
      emitOperation: () => {},
      sendControl: () => {},
    }),
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (handler as any).runChatRequest = async (...args: unknown[]) => {
    handleChatCalls.push(args);
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (handler as any).recordReviewActionRoute({
    type: 'human_review.requested',
    interruptId: 'interrupt-1',
    requestId: 'req-1',
    payload: {
      kind: 'review',
      pendingAction: {
        actionId: 'call-1',
        toolName: 'run_shell',
        args: { command: 'git status', cwd: '/repo' },
        description: 'Run git status',
      },
    },
    review: {
      id: 'review-current',
      schemaVersion: 1,
      view: { kind: 'plain', body: 'Approve?' },
      options: [{
        id: 'approve-and-authorize-thread',
        label: 'Approve and authorize',
        decision: { type: 'approve' },
        effects: [{
          type: 'graph.authorize_tool_action',
          scope: 'thread',
        }],
      }],
    },
  }, { actorId: 'pet-1' }, {} as never);

  await handler.handleHumanReviewResponse(
    fakePeer,
    {
      type: 'human_review_response',
      requestId: 'req-1',
      reviewId: 'review-current',
      selectedOptionId: 'approve-and-authorize-thread',
    },
    {
      actorId: 'pet-1',
    } as never,
  );

  assert.equal(handleChatCalls.length, 1);
  assert.equal(updateStateCalls.length, 0);
  const forwardedMessage = (handleChatCalls[0] as unknown[])[1] as {
    kind: string;
    resume?: unknown;
  };
  const forwardedSource = (handleChatCalls[0] as unknown[])[3];
  assert.deepEqual(forwardedMessage, {
    kind: 'resume',
    requestId: 'req-1',
    resume: {
      'interrupt-1': {
        decisions: [{
          reviewId: 'review-current',
          selectedOptionId: 'approve-and-authorize-thread',
        }],
      },
    },
  });
  assert.deepEqual(forwardedSource, {
    type: 'human_review_response',
    reviewId: 'review-current',
    selectedOptionId: 'approve-and-authorize-thread',
    decisionCount: 1,
  });
  assert.equal(
    sentEvents.some((event) =>
      Boolean(event && typeof event === 'object' && (event as {
        event?: { type?: string };
      }).event?.type === 'system.notice'),
    ),
    false,
  );
});

test('handleHumanReviewResponse does not validate authorization effect context in transport', async () => {
  const handleChatCalls: unknown[] = [];
  const sentEvents: unknown[] = [];
  const updateStateCalls: unknown[] = [];
  const fakePeer = createFakePeer(sentEvents);

  const handler = new LocalServerChatHandler({
    graphService: {
      updateState: async (...args: unknown[]) => {
        updateStateCalls.push(args);
      },
    } as never,
    tuiSessions: {
      getActiveSessionId: () => 'sess-active',
      getChatThreadId: () => 'thread-x',
    } as never,
    inflightRequests: new InflightRequestController({
      emitOperation: () => {},
      sendControl: () => {},
    }),
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (handler as any).runChatRequest = async (...args: unknown[]) => {
    handleChatCalls.push(args);
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (handler as any).recordReviewActionRoute({
    type: 'human_review.requested',
    interruptId: 'interrupt-1',
    requestId: 'req-1',
    payload: {
      kind: 'review',
    },
    review: {
      id: 'review-current',
      schemaVersion: 1,
      view: { kind: 'plain', body: 'Approve?' },
      options: [{
        id: 'approve-and-authorize-thread',
        label: 'Approve and authorize',
        decision: { type: 'approve' },
        effects: [{
          type: 'graph.authorize_tool_action',
          scope: 'thread',
          actionRef: { type: 'pending_action' },
          matcher: { type: 'policy_hook' },
        }],
      }],
    },
  }, { actorId: 'pet-1' }, {} as never);

  await handler.handleHumanReviewResponse(
    fakePeer,
    {
      type: 'human_review_response',
      requestId: 'req-1',
      reviewId: 'review-current',
      selectedOptionId: 'approve-and-authorize-thread',
    },
    { actorId: 'pet-1' } as never,
  );

  assert.equal(handleChatCalls.length, 1);
  assert.equal(updateStateCalls.length, 0);
  assert.equal(sentEvents.length, 0);
});
