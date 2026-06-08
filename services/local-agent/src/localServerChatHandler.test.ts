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
  // 4th arg is the extras forwarded to handleChatRequest
  const forwardedExtras = (handleChatCalls[0] as unknown[])[3];
  assert.deepEqual(forwardedExtras, { originSessionId: 'sess-active' });
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
