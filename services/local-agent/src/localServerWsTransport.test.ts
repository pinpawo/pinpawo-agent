import assert from 'node:assert/strict';
import test from 'node:test';
import type { WebSocket } from 'ws';
import {
  dispatchLocalServerWebSocketMessage,
  type LocalServerWsHandlers,
} from './localServerWsTransport';

function createFakeWebSocket(sent: string[]) {
  return {
    readyState: 1,
    send(data: string) {
      sent.push(data);
    },
  } as unknown as WebSocket;
}

test('local websocket transport dispatches typed client messages and pong', async () => {
  const seen: string[] = [];
  const sent: string[] = [];
  const ws = createFakeWebSocket(sent);
  const handlers: LocalServerWsHandlers = {
    onChatRequest: (_ws, message) => {
      seen.push(`chat:${message.requestId}:${message.message}`);
    },
    onStudioRequest: (_ws, message) => {
      seen.push(`studio:${message.requestId}:${message.userRequest}`);
    },
    onHumanReviewResponse: (_ws, message) => {
      seen.push(`review:${message.requestId}:${message.reviewId}:${message.selectedOptionId}`);
    },
    onInterruptRequest: (_ws, message) => {
      seen.push(`interrupt:${message.requestId}`);
    },
    onNewSession: (_ws, message) => {
      seen.push(`new:${message.userId ?? ''}`);
    },
    onClose: () => {
      seen.push('close');
    },
    log: () => undefined,
  };

  dispatchLocalServerWebSocketMessage(ws, JSON.stringify({ type: 'ping' }), handlers);
  dispatchLocalServerWebSocketMessage(ws, JSON.stringify({ type: 'chat_request', requestId: 'chat-1', message: 'hi' }), handlers);
  dispatchLocalServerWebSocketMessage(ws, JSON.stringify({ type: 'studio_request', requestId: 'studio-1', userRequest: 'plan' }), handlers);
  dispatchLocalServerWebSocketMessage(ws, JSON.stringify({
    type: 'human_review_response',
    requestId: 'review-1',
    reviewId: 'review-spec-1',
    selectedOptionId: 'approve',
  }), handlers);
  dispatchLocalServerWebSocketMessage(ws, JSON.stringify({ type: 'interrupt_request', requestId: 'chat-1' }), handlers);
  dispatchLocalServerWebSocketMessage(ws, JSON.stringify({ type: 'new_session', userId: 'user-1' }), handlers);
  dispatchLocalServerWebSocketMessage(ws, '{bad json', handlers);

  await assertEventually(() => {
    assert.deepEqual(sent.map((item) => JSON.parse(item)), [{ type: 'pong' }]);
    assert.deepEqual(seen, [
      'chat:chat-1:hi',
      'studio:studio-1:plan',
      'review:review-1:review-spec-1:approve',
      'interrupt:chat-1',
      'new:user-1',
    ]);
  });
});

async function assertEventually(assertion: () => void) {
  const startedAt = Date.now();
  let lastError: unknown;
  while (Date.now() - startedAt < 500) {
    try {
      assertion();
      return;
    } catch (err) {
      lastError = err;
      await new Promise((resolve) => {
        setTimeout(resolve, 10);
      });
    }
  }
  throw lastError;
}
