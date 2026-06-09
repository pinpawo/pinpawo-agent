import assert from 'node:assert/strict';
import test from 'node:test';
import { WebSocket } from 'ws';
import { clearToolAuthorizations, isToolActionAuthorized } from '@pinpawo/pet-agent';
import { isToolProtocolHistoryError, LocalServerChatHandler } from './localServerChatHandler';
import { InflightRequestController } from './inflightRequestController';

test('isToolProtocolHistoryError recognizes LangGraph tool history protocol failures', () => {
  assert.equal(isToolProtocolHistoryError(new Error('INVALID_TOOL_RESULTS')), true);
  assert.equal(isToolProtocolHistoryError(new Error("An assistant message with 'tool_calls' must be followed by tool messages")), true);
  assert.equal(isToolProtocolHistoryError('insufficient tool messages following tool_calls message'), true);
  assert.equal(isToolProtocolHistoryError(new Error('ordinary model error')), false);
});

test('handleHumanReviewResponse rejects when extras.originSessionId does not match the active session', async () => {
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
  // Replace handleChatRequest with a spy to confirm the guard short-circuits.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (handler as any).handleChatRequest = async (...args: unknown[]) => {
    handleChatCalls.push(args);
  };

  await handler.handleHumanReviewResponse(
    fakeWs,
    {
      type: 'human_review_response',
      requestId: 'req-1',
      message: '批准',
      resume: { decisions: [{ type: 'approve' }] },
      extras: { originSessionId: 'sess-other' },
    },
    { actorId: 'pet-1' } as never,
  );

  assert.equal(handleChatCalls.length, 0, 'guard should prevent forwarding to chat handler');
  assert.equal(sentEvents.length, 1, 'guard should emit a single error event');
  const event = sentEvents[0] as { type: string; event?: { type: string; requestId: string } };
  assert.equal(event.type, 'event');
  assert.equal(event.event?.type, 'error');
  assert.equal(event.event?.requestId, 'req-1');
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
  (handler as any).handleChatRequest = async (...args: unknown[]) => {
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
  }, 'thread-x', { actorId: 'pet-1' });

  await handler.handleHumanReviewResponse(
    fakeWs,
    {
      type: 'human_review_response',
      requestId: 'req-1',
      message: '',
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

test('handleHumanReviewResponse rejects canonical option without reviewId', async () => {
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
  (handler as any).handleChatRequest = async (...args: unknown[]) => {
    handleChatCalls.push(args);
  };

  await handler.handleHumanReviewResponse(
    fakeWs,
    {
      type: 'human_review_response',
      requestId: 'req-1',
      message: '',
      selectedOptionId: 'approve',
    },
    { actorId: 'pet-1' } as never,
  );

  assert.equal(handleChatCalls.length, 0);
  assert.equal(sentEvents.length, 1);
  const event = sentEvents[0] as { type: string; event?: { type: string; message: string } };
  assert.equal(event.type, 'event');
  assert.equal(event.event?.type, 'error');
  assert.match(event.event?.message ?? '', /reviewId/);
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
  (handler as any).handleChatRequest = async (...args: unknown[]) => {
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
  }, 'thread-x', { actorId: 'pet-1' });

  const message = {
    type: 'human_review_response' as const,
    requestId: 'req-1',
    message: '',
    reviewId: 'review-current',
    selectedOptionId: 'approve',
  };
  await handler.handleHumanReviewResponse(fakeWs, message, { actorId: 'pet-1' } as never);
  await handler.handleHumanReviewResponse(fakeWs, message, { actorId: 'pet-1' } as never);

  assert.equal(handleChatCalls.length, 1, 'matching review response should be forwarded once');
  const forwardedMessage = (handleChatCalls[0] as unknown[])[1] as {
    type: string;
    requestId: string;
    message: string;
    resume?: unknown;
  };
  assert.deepEqual(forwardedMessage, {
    type: 'chat_request',
    requestId: 'req-1',
    message: 'Approve',
    resume: { decisions: [{ type: 'approve' }] },
  });
  assert.equal(sentEvents.length, 1, 'second response should be rejected after route is consumed');
  const event = sentEvents[0] as { type: string; event?: { type: string; message: string } };
  assert.equal(event.type, 'event');
  assert.equal(event.event?.type, 'error');
  assert.match(event.event?.message ?? '', /已关闭|不存在/);
});

test('handleHumanReviewResponse resolves canonical respond input and keeps route after invalid option', async () => {
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
  (handler as any).handleChatRequest = async (...args: unknown[]) => {
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
  }, 'thread-x', { actorId: 'pet-1' });

  await handler.handleHumanReviewResponse(
    fakeWs,
    {
      type: 'human_review_response',
      requestId: 'req-1',
      message: '',
      reviewId: 'review-current',
      selectedOptionId: 'approve',
    },
    { actorId: 'pet-1' } as never,
  );
  await handler.handleHumanReviewResponse(
    fakeWs,
    {
      type: 'human_review_response',
      requestId: 'req-1',
      message: '',
      reviewId: 'review-current',
      selectedOptionId: 'respond',
      input: { message: '请先解释风险' },
      resume: { decisions: [{ type: 'approve' }] },
    },
    { actorId: 'pet-1' } as never,
  );

  assert.equal(sentEvents.length, 1, 'invalid option should emit an error');
  assert.equal(handleChatCalls.length, 1, 'valid retry should still reach chat handler');
  const forwardedMessage = (handleChatCalls[0] as unknown[])[1] as {
    message: string;
    resume?: unknown;
  };
  assert.deepEqual(forwardedMessage, {
    type: 'chat_request',
    requestId: 'req-1',
    message: '请先解释风险',
    resume: { decisions: [{ type: 'respond', message: '请先解释风险' }] },
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
  (handler as any).handleChatRequest = async (...args: unknown[]) => {
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
  }, 'thread-x', { actorId: 'pet-1' });
  activeSessionId = 'sess-other';

  await handler.handleHumanReviewResponse(
    fakeWs,
    {
      type: 'human_review_response',
      requestId: 'req-1',
      message: '',
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

test('handleHumanReviewResponse forwards to chat handler when originSessionId matches', async () => {
  const handleChatCalls: unknown[] = [];
  const fakeWs = { readyState: WebSocket.OPEN, send: () => {} } as unknown as WebSocket;

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
  (handler as any).handleChatRequest = async (...args: unknown[]) => {
    handleChatCalls.push(args);
  };

  await handler.handleHumanReviewResponse(
    fakeWs,
    {
      type: 'human_review_response',
      requestId: 'req-1',
      message: '批准',
      resume: { decisions: [{ type: 'approve' }] },
      extras: { originSessionId: 'sess-active' },
    },
    { actorId: 'pet-1' } as never,
  );

  assert.equal(handleChatCalls.length, 1, 'matching origin should forward to chat handler');
  assert.equal((handleChatCalls[0] as unknown[]).length, 3);
});

test('handleHumanReviewResponse forwards when extras.originSessionId is absent (no guard)', async () => {
  const handleChatCalls: unknown[] = [];
  const fakeWs = { readyState: WebSocket.OPEN, send: () => {} } as unknown as WebSocket;

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
  (handler as any).handleChatRequest = async (...args: unknown[]) => {
    handleChatCalls.push(args);
  };

  await handler.handleHumanReviewResponse(
    fakeWs,
    {
      type: 'human_review_response',
      requestId: 'req-1',
      message: '批准',
      resume: { decisions: [{ type: 'approve' }] },
    },
    { actorId: 'pet-1' } as never,
  );

  assert.equal(handleChatCalls.length, 1, 'absent origin should forward without guarding');
});

test('handleHumanReviewResponse applies declared authorization effects before forwarding', async () => {
  clearToolAuthorizations('thread-x');
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
  (handler as any).handleChatRequest = async (...args: unknown[]) => {
    handleChatCalls.push(args);
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (handler as any).recordPendingReviewRoute({
    type: 'human_review.requested',
    requestId: 'req-1',
    payload: {
      actionRequests: [{
        name: 'run_shell',
        args: { command: 'git status', cwd: '/repo' },
        description: 'Run git status',
      }],
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
  }, 'thread-x', { actorId: 'pet-1' });

  await handler.handleHumanReviewResponse(
    fakeWs,
    {
      type: 'human_review_response',
      requestId: 'req-1',
      message: '',
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
  assert.equal(
    isToolActionAuthorized({
      threadId: 'thread-x',
      toolName: 'run_shell',
      args: { command: 'git status', cwd: '/repo' },
    }),
    true,
  );
  const forwardedMessage = (handleChatCalls[0] as unknown[])[1] as {
    message: string;
    resume?: unknown;
  };
  assert.deepEqual(forwardedMessage, {
    type: 'chat_request',
    requestId: 'req-1',
    message: 'Approve and authorize',
    resume: { decisions: [{ type: 'approve' }] },
  });
  assert.equal(
    sentEvents.some((event) =>
      Boolean(event && typeof event === 'object' && (event as {
        event?: { type?: string };
      }).event?.type === 'system.notice'),
    ),
    true,
  );
  clearToolAuthorizations('thread-x');
});
