import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { createServer } from 'node:http';
import test from 'node:test';
import { WebSocket, type ClientOptions } from 'ws';
import {
  attachLocalServerWebSocketTransport,
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
  const warnings: string[] = [];
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
    onRuntimeConfigUpdate: (_ws, message) => {
      seen.push(`policy:${message.globalReviewPolicyMode}`);
    },
    onClose: () => {
      seen.push('close');
    },
    log: () => undefined,
    logWarn: (message) => {
      warnings.push(message);
    },
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
  dispatchLocalServerWebSocketMessage(ws, JSON.stringify({
    type: 'runtime_config.update',
    globalReviewPolicyMode: 'auto_authorization',
  }), handlers);
  dispatchLocalServerWebSocketMessage(ws, JSON.stringify({
    type: 'chat_request',
    requestId: 'chat-old',
    message: 'Approve',
    resume: { reviewId: 'review-1', selectedOptionId: 'approve' },
  }), handlers);
  dispatchLocalServerWebSocketMessage(ws, '{bad json', handlers);

  await assertEventually(() => {
    assert.deepEqual(sent.map((item) => JSON.parse(item)), [
      { type: 'pong' },
      {
        type: 'event',
        requestId: 'chat-old',
        event: {
          type: 'error',
          requestId: 'chat-old',
          message: '客户端消息协议不兼容或格式无效，请升级客户端后重试。',
        },
      },
    ]);
    assert.deepEqual(seen, [
      'chat:chat-1:hi',
      'studio:studio-1:plan',
      'review:review-1:review-spec-1:approve',
      'interrupt:chat-1',
      'new:user-1',
      'policy:auto_authorization',
    ]);
    assert.deepEqual(warnings, [
      '[local-server] ignored malformed client message type=chat_request requestId=chat-old',
      '[local-server] ignored malformed client message type=unknown requestId=unknown',
    ]);
  });
});

test('local websocket transport enforces token and Origin during upgrade', async () => {
  const server = createServer();
  const handlers = createHandlers();
  attachLocalServerWebSocketTransport(server, handlers, {
    authToken: 'secret',
    port: 0,
  });
  await listen(server);
  const address = server.address();
  assertAddressInfo(address);
  const port = address.port;

  try {
    await assert.rejects(openWebSocket(`ws://127.0.0.1:${port}`));
    await assert.rejects(openWebSocket(`ws://127.0.0.1:${port}/?token=secret`));
    await assert.rejects(openWebSocket(`ws://127.0.0.1:${port}`, {
      headers: {
        Authorization: 'Bearer secret',
        Origin: 'https://evil.example',
      },
    }));
    const ws = await openWebSocket(`ws://127.0.0.1:${port}`, {
      headers: {
        Authorization: 'Bearer secret',
      },
    });
    ws.close();
  } finally {
    await closeServer(server);
  }
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

function createHandlers(): LocalServerWsHandlers {
  return {
    onChatRequest: () => undefined,
    onStudioRequest: () => undefined,
    onHumanReviewResponse: () => undefined,
    onInterruptRequest: () => undefined,
    onNewSession: () => undefined,
    onRuntimeConfigUpdate: () => undefined,
    onClose: () => undefined,
    log: () => undefined,
  };
}

function listen(server: ReturnType<typeof createServer>) {
  return new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
}

function closeServer(server: ReturnType<typeof createServer>) {
  return new Promise<void>((resolve, reject) => {
    server.close((err) => {
      if (err) {
        reject(err);
      } else {
        resolve();
      }
    });
  });
}

function openWebSocket(url: string, options?: ClientOptions) {
  return new Promise<WebSocket>((resolve, reject) => {
    const ws = new WebSocket(url, options);
    ws.once('open', () => {
      ws.off('error', reject);
      resolve(ws);
    });
    ws.once('error', reject);
  });
}

function assertAddressInfo(address: ReturnType<ReturnType<typeof createServer>['address']>): asserts address is AddressInfo {
  assert.equal(typeof address, 'object');
  assert.notEqual(address, null);
}
