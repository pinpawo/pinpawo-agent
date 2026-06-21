import assert from 'node:assert/strict';
import test from 'node:test';
import { WebSocket } from 'ws';
import { isToolProtocolHistoryError, LocalServerChatHandler } from './localServerChatHandler';
import { InflightRequestController } from './inflightRequestController';

test('isToolProtocolHistoryError recognizes LangGraph tool history protocol failures', () => {
  assert.equal(isToolProtocolHistoryError(new Error('INVALID_TOOL_RESULTS')), true);
  assert.equal(isToolProtocolHistoryError(new Error("An assistant message with 'tool_calls' must be followed by tool messages")), true);
  assert.equal(isToolProtocolHistoryError('insufficient tool messages following tool_calls message'), true);
  assert.equal(isToolProtocolHistoryError(new Error('ordinary model error')), false);
});

test('handleHumanReviewResponse rejects stale canonical reviewId before forwarding', async () => {
  const handleChatCalls: unknown[] = [];
  const sentEvents: unknown[] = [];
  const fakeWs = {
    readyState: WebSocket.OPEN,
    send: (data: string) => {
      sentEvents.push(JSON.parse(data));
    },
  } as unknown as WebSocket;
  const tuiSessions = {
    getActiveSessionId: () => 'sess-active',
    getChatThreadId: () => 'thread-x',
    readActivePendingReview: async () => ({
      sessionId: 'sess-active',
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
      forceInterruptMs: 1000,
      emitOperation: () => {},
      sendControl: () => {},
    }),
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (handler as any).runChatRequest = async (...args: unknown[]) => {
    handleChatCalls.push(args);
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (handler as any).recordPendingReviewRoute({
    type: 'human_review.requested',
    requestId: 'req-1',
    review: {
      id: 'review-current',
      schemaVersion: 1,
      view: { kind: 'plain', body: 'Approve?' },
      options: [{ id: 'approve', label: 'Approve', decision: { type: 'approve' } }],
    },
  }, { actorId: 'pet-1' });

  await handler.handleHumanReviewResponse(
    fakeWs,
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
  const event = sentEvents[0] as { type: string; event?: { type: string; requestId: string; message: string } };
  assert.equal(event.type, 'event');
  assert.equal(event.event?.type, 'error');
  assert.equal(event.event?.requestId, 'req-1');
  assert.match(event.event?.message ?? '', /过期/);
});

test('handleHumanReviewResponse consumes matching canonical review route once', async () => {
  const handleChatCalls: unknown[] = [];
  const sentEvents: unknown[] = [];
  const fakeWs = {
    readyState: WebSocket.OPEN,
    send: (data: string) => {
      sentEvents.push(JSON.parse(data));
    },
  } as unknown as WebSocket;
  const tuiSessions = {
    getActiveSessionId: () => 'sess-active',
    getChatThreadId: () => 'thread-x',
    readActivePendingReview: async () => null,
  } as never;
  const handler = new LocalServerChatHandler({
    graphService: {} as never,
    tuiSessions,
    inflightRequests: new InflightRequestController({
      forceInterruptMs: 1000,
      emitOperation: () => {},
      sendControl: () => {},
    }),
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (handler as any).runChatRequest = async (...args: unknown[]) => {
    handleChatCalls.push(args);
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (handler as any).recordPendingReviewRoute({
    type: 'human_review.requested',
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
  await handler.handleHumanReviewResponse(fakeWs, message, { actorId: 'pet-1' } as never);
  await handler.handleHumanReviewResponse(fakeWs, message, { actorId: 'pet-1' } as never);

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
      reviewId: 'review-current',
      selectedOptionId: 'approve',
    },
  });
  assert.deepEqual(forwardedSource, {
    type: 'human_review_response',
    reviewId: 'review-current',
    selectedOptionId: 'approve',
  });
  assert.equal(sentEvents.length, 1, 'second response should be rejected after route is consumed');
  const event = sentEvents[0] as { type: string; event?: { type: string; message: string } };
  assert.equal(event.type, 'event');
  assert.equal(event.event?.type, 'error');
  assert.match(event.event?.message ?? '', /已关闭|不存在/);

  const interruptHandled = await handler.handleInterruptRequest(
    fakeWs,
    {
      type: 'interrupt_request',
      requestId: 'req-1',
    },
    { actorId: 'pet-1' } as never,
  );
  assert.equal(interruptHandled, false, 'consumed review route should fall through to inflight interrupt');
  assert.equal(handleChatCalls.length, 1);
  assert.equal(sentEvents.length, 1);
});

test('handleHumanReviewResponse recovers missing route from active checkpoint review', async () => {
  const handleChatCalls: unknown[] = [];
  const sentEvents: unknown[] = [];
  const fakeWs = {
    readyState: WebSocket.OPEN,
    send: (data: string) => {
      sentEvents.push(JSON.parse(data));
    },
  } as unknown as WebSocket;
  const handler = new LocalServerChatHandler({
    graphService: {} as never,
    tuiSessions: {
      getActiveSessionId: () => 'sess-active',
      getChatThreadId: () => 'thread-x',
      readActivePendingReview: async () => ({
        sessionId: 'sess-active',
        review: {
          id: 'review-current',
          schemaVersion: 1,
          view: { kind: 'plain', body: 'Approve?' },
          options: [{ id: 'approve', label: 'Approve', decision: { type: 'approve' } }],
        },
      }),
    } as never,
    inflightRequests: new InflightRequestController({
      forceInterruptMs: 1000,
      emitOperation: () => {},
      sendControl: () => {},
    }),
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (handler as any).runChatRequest = async (...args: unknown[]) => {
    handleChatCalls.push(args);
  };

  await handler.handleHumanReviewResponse(
    fakeWs,
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
      reviewId: 'review-current',
      selectedOptionId: 'approve',
    },
  });
});

test('readPendingReviewSnapshot exposes routeable pending review request ids', async () => {
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
      forceInterruptMs: 1000,
      emitOperation: () => {},
      sendControl: () => {},
    }),
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (handler as any).recordPendingReviewRoute({
    type: 'human_review.requested',
    requestId: 'req-existing',
    review,
    actor: { petId: 'pet-a' },
  }, { actorId: 'pet-1' });

  assert.deepEqual(await handler.readPendingReviewSnapshot({ actorId: 'pet-1' } as never), {
    requestId: 'req-existing',
    reviewId: 'review-current',
    sessionId: 'sess-active',
    review,
    actor: { petId: 'pet-a' },
  });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (handler as any).pendingReviewRoutes.clear();
  assert.deepEqual(await handler.readPendingReviewSnapshot({ actorId: 'pet-1' } as never), {
    requestId: 'snapshot:sess-active:review-current',
    reviewId: 'review-current',
    sessionId: 'sess-active',
    review,
  });
});

test('handleInterruptRequest resumes pending review with canonical reject option', async () => {
  const handleChatCalls: unknown[] = [];
  const sentEvents: unknown[] = [];
  const fakeWs = {
    readyState: WebSocket.OPEN,
    send: (data: string) => {
      sentEvents.push(JSON.parse(data));
    },
  } as unknown as WebSocket;
  const handler = new LocalServerChatHandler({
    graphService: {} as never,
    tuiSessions: {
      getActiveSessionId: () => 'sess-active',
      getChatThreadId: () => 'thread-x',
      readActivePendingReview: async () => ({
        sessionId: 'sess-active',
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
      forceInterruptMs: 1000,
      emitOperation: () => {},
      sendControl: () => {},
    }),
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (handler as any).runChatRequest = async (...args: unknown[]) => {
    handleChatCalls.push(args);
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (handler as any).recordPendingReviewRoute({
    type: 'human_review.requested',
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

  const handled = await handler.handleInterruptRequest(
    fakeWs,
    {
      type: 'interrupt_request',
      requestId: 'req-1',
    },
    { actorId: 'pet-1' } as never,
  );

  assert.equal(handled, true);
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
      reviewId: 'review-current',
      selectedOptionId: 'reject',
    },
  });
  assert.deepEqual(forwardedSource, {
    type: 'interrupt_request',
    reviewId: 'review-current',
    selectedOptionId: 'reject',
  });

  await handler.handleHumanReviewResponse(
    fakeWs,
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
  const event = sentEvents[0] as { type: string; event?: { type: string; message: string } };
  assert.equal(event.type, 'event');
  assert.equal(event.event?.type, 'error');
  assert.match(event.event?.message ?? '', /已关闭|不存在/);
});

test('handleInterruptRequest recovers missing route from active checkpoint review', async () => {
  const handleChatCalls: unknown[] = [];
  const sentEvents: unknown[] = [];
  const fakeWs = {
    readyState: WebSocket.OPEN,
    send: (data: string) => {
      sentEvents.push(JSON.parse(data));
    },
  } as unknown as WebSocket;
  const handler = new LocalServerChatHandler({
    graphService: {} as never,
    tuiSessions: {
      getActiveSessionId: () => 'sess-active',
      getChatThreadId: () => 'thread-x',
      readActivePendingReview: async () => ({
        sessionId: 'sess-active',
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
      forceInterruptMs: 1000,
      emitOperation: () => {},
      sendControl: () => {},
    }),
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (handler as any).runChatRequest = async (...args: unknown[]) => {
    handleChatCalls.push(args);
  };

  const handled = await handler.handleInterruptRequest(
    fakeWs,
    {
      type: 'interrupt_request',
      requestId: 'req-1',
    },
    { actorId: 'pet-1' } as never,
  );

  assert.equal(handled, true);
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
      reviewId: 'review-current',
      selectedOptionId: 'reject',
    },
  });
  assert.deepEqual(forwardedSource, {
    type: 'interrupt_request',
    reviewId: 'review-current',
    selectedOptionId: 'reject',
  });
});

test('handleInterruptRequest restores pending review when no reject option exists', async () => {
  const handleChatCalls: unknown[] = [];
  const sentEvents: unknown[] = [];
  const fakeWs = {
    readyState: WebSocket.OPEN,
    send: (data: string) => {
      sentEvents.push(JSON.parse(data));
    },
  } as unknown as WebSocket;
  const handler = new LocalServerChatHandler({
    graphService: {} as never,
    tuiSessions: {
      getActiveSessionId: () => 'sess-active',
      getChatThreadId: () => 'thread-x',
    } as never,
    inflightRequests: new InflightRequestController({
      forceInterruptMs: 1000,
      emitOperation: () => {},
      sendControl: () => {},
    }),
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (handler as any).runChatRequest = async (...args: unknown[]) => {
    handleChatCalls.push(args);
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (handler as any).recordPendingReviewRoute({
    type: 'human_review.requested',
    requestId: 'req-1',
    prompt: 'Approve?',
    review: {
      id: 'review-current',
      schemaVersion: 1,
      view: { kind: 'plain', body: 'Approve?' },
      options: [{ id: 'approve', label: 'Approve', decision: { type: 'approve' } }],
    },
  }, { actorId: 'pet-1' });

  const handled = await handler.handleInterruptRequest(
    fakeWs,
    {
      type: 'interrupt_request',
      requestId: 'req-1',
    },
    { actorId: 'pet-1' } as never,
  );

  assert.equal(handled, true);
  assert.equal(handleChatCalls.length, 0);
  assert.equal(sentEvents.length, 2);
  const notice = sentEvents[0] as { type: string; event?: { type: string; message: string } };
  assert.equal(notice.event?.type, 'system.notice');
  assert.match(notice.event?.message ?? '', /无法自动取消/);
  const reviewEvent = sentEvents[1] as {
    type: string;
    event?: { type: string; requestId: string; review?: { id: string } };
  };
  assert.equal(reviewEvent.event?.type, 'human_review.requested');
  assert.equal(reviewEvent.event?.requestId, 'req-1');
  assert.equal(reviewEvent.event?.review?.id, 'review-current');

  await handler.handleHumanReviewResponse(
    fakeWs,
    {
      type: 'human_review_response',
      requestId: 'req-1',
      reviewId: 'review-current',
      selectedOptionId: 'approve',
    },
    { actorId: 'pet-1' } as never,
  );

  assert.equal(handleChatCalls.length, 1, 'route should remain available after failed interrupt');
});

test('handleHumanReviewResponse forwards canonical selected option without resolving it', async () => {
  const handleChatCalls: unknown[] = [];
  const sentEvents: unknown[] = [];
  const fakeWs = {
    readyState: WebSocket.OPEN,
    send: (data: string) => {
      sentEvents.push(JSON.parse(data));
    },
  } as unknown as WebSocket;
  const tuiSessions = {
    getActiveSessionId: () => 'sess-active',
    getChatThreadId: () => 'thread-x',
  } as never;
  const handler = new LocalServerChatHandler({
    graphService: {} as never,
    tuiSessions,
    inflightRequests: new InflightRequestController({
      forceInterruptMs: 1000,
      emitOperation: () => {},
      sendControl: () => {},
    }),
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (handler as any).runChatRequest = async (...args: unknown[]) => {
    handleChatCalls.push(args);
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (handler as any).recordPendingReviewRoute({
    type: 'human_review.requested',
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
    fakeWs,
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
      reviewId: 'review-current',
      selectedOptionId: 'respond',
      input: { message: '请先解释风险' },
    },
  });
  assert.deepEqual(forwardedSource, {
    type: 'human_review_response',
    reviewId: 'review-current',
    selectedOptionId: 'respond',
  });
});

test('handleHumanReviewResponse rejects canonical review response from a different active session', async () => {
  const handleChatCalls: unknown[] = [];
  const sentEvents: unknown[] = [];
  let activeSessionId = 'sess-origin';
  const fakeWs = {
    readyState: WebSocket.OPEN,
    send: (data: string) => {
      sentEvents.push(JSON.parse(data));
    },
  } as unknown as WebSocket;
  const tuiSessions = {
    getActiveSessionId: () => activeSessionId,
    getChatThreadId: () => 'thread-x',
  } as never;
  const handler = new LocalServerChatHandler({
    graphService: {} as never,
    tuiSessions,
    inflightRequests: new InflightRequestController({
      forceInterruptMs: 1000,
      emitOperation: () => {},
      sendControl: () => {},
    }),
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (handler as any).runChatRequest = async (...args: unknown[]) => {
    handleChatCalls.push(args);
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (handler as any).recordPendingReviewRoute({
    type: 'human_review.requested',
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
    fakeWs,
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
  const event = sentEvents[0] as { type: string; event?: { type: string; message: string } };
  assert.equal(event.type, 'event');
  assert.equal(event.event?.type, 'error');
  assert.match(event.event?.message ?? '', /发起该 review 的会话/);
});

test('handleHumanReviewResponse forwards effect-bearing options without local authorization side effects', async () => {
  const handleChatCalls: unknown[] = [];
  const sentEvents: unknown[] = [];
  const updateStateCalls: unknown[] = [];
  const fakeWs = {
    readyState: WebSocket.OPEN,
    send: (data: string) => {
      sentEvents.push(JSON.parse(data));
    },
  } as unknown as WebSocket;

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
      forceInterruptMs: 1000,
      emitOperation: () => {},
      sendControl: () => {},
    }),
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (handler as any).runChatRequest = async (...args: unknown[]) => {
    handleChatCalls.push(args);
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (handler as any).recordPendingReviewRoute({
    type: 'human_review.requested',
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
          actionRef: { type: 'pending_action' },
          matcher: { type: 'policy_hook' },
        }],
      }],
    },
  }, { actorId: 'pet-1' }, {} as never);

  await handler.handleHumanReviewResponse(
    fakeWs,
    {
      type: 'human_review_response',
      requestId: 'req-1',
      reviewId: 'review-current',
      selectedOptionId: 'approve-and-authorize-thread',
    },
    {
      actorId: 'pet-1',
      localToolkits: [{
        name: 'local',
        description: 'local tools',
        policy: {
          toolReview: {
            run_shell: {
              request: () => null,
              buildAuthorizationMatcher: (ctx: { input: unknown }) => ({
                type: 'shell_pattern',
                value: (ctx.input as { command: string }).command,
              }),
            },
          },
        },
      }],
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
      reviewId: 'review-current',
      selectedOptionId: 'approve-and-authorize-thread',
    },
  });
  assert.deepEqual(forwardedSource, {
    type: 'human_review_response',
    reviewId: 'review-current',
    selectedOptionId: 'approve-and-authorize-thread',
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
  const fakeWs = {
    readyState: WebSocket.OPEN,
    send: (data: string) => {
      sentEvents.push(JSON.parse(data));
    },
  } as unknown as WebSocket;

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
      forceInterruptMs: 1000,
      emitOperation: () => {},
      sendControl: () => {},
    }),
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (handler as any).runChatRequest = async (...args: unknown[]) => {
    handleChatCalls.push(args);
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (handler as any).recordPendingReviewRoute({
    type: 'human_review.requested',
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
    fakeWs,
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
