import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { setTimeout as sleep } from 'node:timers/promises';
import test from 'node:test';
import { WebSocket } from 'ws';
import {
  dispatchLocalAgentAppWebSocketMessage,
  LocalAgentAppWsClient,
  type LocalAgentAppWsClientHandlers,
} from './localAgentAppWsClient';

class FakeWebSocket extends EventEmitter {
  readyState: number = WebSocket.OPEN;
  sent: unknown[] = [];
  closed = false;

  send(data: string) {
    this.sent.push(JSON.parse(data) as unknown);
  }

  close() {
    this.closed = true;
    this.readyState = WebSocket.CLOSED;
    this.emit('close', 1000, Buffer.alloc(0));
  }
}

function createHandlers(events: string[] = []): LocalAgentAppWsClientHandlers {
  return {
    onChatRequest: async (_ws, message) => {
      events.push(`chat:${message.requestId}`);
    },
    onNewSession: async (_ws, message) => {
      events.push(`new:${message.userId ?? ''}`);
    },
    onInterruptRequest: async (_ws, message) => {
      events.push(`interrupt:${message.requestId}`);
    },
    onHumanReviewResponse: async (_ws, message) => {
      events.push(`review:${message.requestId}:${message.reviewId}:${message.selectedOptionId}`);
    },
    onClose: async () => {
      events.push('close');
    },
  };
}

async function tick() {
  await sleep(0);
}

test('dispatchLocalAgentAppWebSocketMessage routes app chat protocol messages', async () => {
  const ws = new FakeWebSocket() as unknown as WebSocket;
  const events: string[] = [];
  const warnings: string[] = [];
  const handlers = createHandlers(events);

  dispatchLocalAgentAppWebSocketMessage(ws, JSON.stringify({
    type: 'chat_request',
    requestId: 'req-1',
    message: 'hello',
    userId: 'user-1',
  }), handlers);
  dispatchLocalAgentAppWebSocketMessage(ws, JSON.stringify({
    type: 'new_session',
    userId: 'user-1',
  }), handlers);
  dispatchLocalAgentAppWebSocketMessage(ws, JSON.stringify({
    type: 'interrupt_request',
    requestId: 'req-1',
  }), handlers);
  dispatchLocalAgentAppWebSocketMessage(ws, JSON.stringify({
    type: 'human_review_response',
    requestId: 'req-1',
    reviewId: 'review-1',
    selectedOptionId: 'approve',
  }), handlers);
  dispatchLocalAgentAppWebSocketMessage(ws, JSON.stringify({
    type: 'human_review_response',
    requestId: 'req-1',
    reviewId: 'review-1',
    selectedOptionId: 'approve',
    message: 'Approve',
  }), handlers, undefined, (message) => {
    warnings.push(message);
  });

  await tick();

  assert.deepEqual(events, [
    'chat:req-1',
    'new:user-1',
    'interrupt:req-1',
    'review:req-1:review-1:approve',
  ]);
  assert.deepEqual(warnings, [
    '[local-agent] ignored malformed app client message type=human_review_response requestId=req-1',
  ]);
  assert.deepEqual((ws as unknown as FakeWebSocket).sent, [{
    type: 'event',
    requestId: 'req-1',
    event: {
      type: 'error',
      requestId: 'req-1',
      message: '客户端消息协议不兼容或格式无效，请升级客户端后重试。',
    },
  }]);
});

test('dispatchLocalAgentAppWebSocketMessage replies to ping with pong', () => {
  const fake = new FakeWebSocket();
  dispatchLocalAgentAppWebSocketMessage(
    fake as unknown as WebSocket,
    JSON.stringify({ type: 'ping' }),
    createHandlers(),
  );

  assert.deepEqual(fake.sent, [{ type: 'pong' }]);
});

test('LocalAgentAppWsClient reconnects after remote close and stops after disconnect', async () => {
  const sockets: FakeWebSocket[] = [];
  const events: string[] = [];
  const client = new LocalAgentAppWsClient({
    actorId: 'pet-a',
    url: 'ws://example.test/ws',
    reconnectDelayMs: 1,
    pingIntervalMs: 10_000,
    handlers: createHandlers(events),
    webSocketFactory: () => {
      const ws = new FakeWebSocket();
      sockets.push(ws);
      return ws as unknown as WebSocket;
    },
    log: () => undefined,
    logError: () => undefined,
    logWarn: () => undefined,
  });

  client.connect();
  assert.equal(sockets.length, 1);

  sockets[0]?.emit('message', JSON.stringify({
    type: 'chat_request',
    requestId: 'req-1',
    message: 'hello',
    userId: 'user-1',
  }));
  await tick();
  assert.deepEqual(events, ['chat:req-1']);

  sockets[0]?.emit('close', 1000, Buffer.alloc(0));
  await sleep(5);
  assert.equal(sockets.length, 2);
  assert.deepEqual(events, ['chat:req-1', 'close']);
  assert.equal(client.isCurrentSocket(sockets[1] as unknown as WebSocket), true);

  client.disconnect();
  assert.equal(sockets[1]?.closed, true);
  await sleep(5);
  assert.equal(sockets.length, 2);
});
