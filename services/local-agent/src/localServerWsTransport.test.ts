import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { createServer } from 'node:http';
import test from 'node:test';
import { WebSocket, type ClientOptions } from 'ws';
import {
  attachLocalServerWebSocketTransport,
  createLocalServerWebSocketPeer,
} from './localServerWsTransport';
import {
  type LocalServerPeerHandlers,
} from './localServerMessageDispatcher';
import type { LocalServerPeer } from './localServerPeer';

test('local websocket peer owns socket readiness, serialization, and send failures', () => {
  const sent: unknown[] = [];
  const errors: string[] = [];
  const socket = {
    readyState: WebSocket.OPEN as number,
    send(data: string) {
      sent.push(JSON.parse(data) as unknown);
    },
  };
  const peer = createLocalServerWebSocketPeer(
    socket as unknown as WebSocket,
    (message, error) => {
      errors.push(`${message}${error instanceof Error ? error.message : String(error)}`);
    },
  );

  assert.equal(peer.isConnected(), true);
  assert.equal(peer.send({ type: 'pong' }), true);
  assert.deepEqual(sent, [{ type: 'pong' }]);

  socket.readyState = WebSocket.CLOSED;
  assert.equal(peer.isConnected(), false);
  assert.equal(peer.send({ type: 'pong' }), false);

  socket.readyState = WebSocket.OPEN;
  socket.send = () => {
    throw new Error('write failed');
  };
  assert.equal(peer.send({ type: 'pong' }), false);
  assert.deepEqual(errors, ['[local-server] failed to send websocket message:write failed']);
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

test('local websocket transport keeps one peer identity through message and close', { timeout: 2_000 }, async () => {
  const server = createServer();
  const peers: LocalServerPeer[] = [];
  let resolveMessageHandled: () => void = () => undefined;
  let resolveClosed: () => void = () => undefined;
  const messageHandled = new Promise<void>((resolve) => {
    resolveMessageHandled = resolve;
  });
  const closed = new Promise<void>((resolve) => {
    resolveClosed = resolve;
  });
  const handlers: LocalServerPeerHandlers = {
    ...createHandlers(),
    onChatRequest: (peer) => {
      peers.push(peer);
      resolveMessageHandled();
    },
    onClose: (peer) => {
      peers.push(peer);
      resolveClosed();
    },
  };
  attachLocalServerWebSocketTransport(server, handlers, {
    authToken: 'secret',
    port: 0,
  });
  await listen(server);
  const address = server.address();
  assertAddressInfo(address);

  let ws: WebSocket | null = null;
  try {
    ws = await openWebSocket(`ws://127.0.0.1:${address.port}`, {
      headers: {
        Authorization: 'Bearer secret',
      },
    });
    const pong = waitForWebSocketMessage(ws);
    ws.send(JSON.stringify({ type: 'ping' }));
    assert.deepEqual(await pong, { type: 'pong' });

    const malformedError = waitForWebSocketMessage(ws);
    ws.send(JSON.stringify({
      type: 'chat_request',
      requestId: 'chat-old',
      message: 'Approve',
      resume: { reviewId: 'review-1', selectedOptionId: 'approve' },
    }));
    assert.deepEqual(await malformedError, {
      type: 'event',
      requestId: 'chat-old',
      event: {
        type: 'error',
        requestId: 'chat-old',
        message: '客户端消息协议不兼容或格式无效，请升级客户端后重试。',
      },
    });

    ws.send(JSON.stringify({
      type: 'chat_request',
      requestId: 'chat-1',
      message: 'hi',
    }));
    await messageHandled;
    ws.close();
    await closed;

    assert.equal(peers.length, 2);
    assert.equal(peers[0], peers[1]);
  } finally {
    if (ws && ws.readyState !== WebSocket.CLOSED) {
      ws.terminate();
    }
    await closeServer(server);
  }
});

function createHandlers(): LocalServerPeerHandlers {
  return {
    onChatRequest: () => undefined,
    onStudioRequest: () => undefined,
    onHumanReviewResponse: () => undefined,
    onReviewCancel: () => undefined,
    onRunInterrupt: () => undefined,
    onNewSession: () => undefined,
    onRuntimeConfigUpdate: () => undefined,
    onSessionSnapshotGet: () => undefined,
    onSessionList: () => undefined,
    onSessionNew: () => undefined,
    onSessionResume: () => undefined,
    onModelList: () => undefined,
    onModelSelect: () => undefined,
    onClose: () => undefined,
    log: () => undefined,
    logWarn: () => undefined,
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

function waitForWebSocketMessage(ws: WebSocket) {
  return new Promise<unknown>((resolve) => {
    ws.once('message', (data) => {
      resolve(JSON.parse(data.toString()) as unknown);
    });
  });
}

function assertAddressInfo(address: ReturnType<ReturnType<typeof createServer>['address']>): asserts address is AddressInfo {
  assert.equal(typeof address, 'object');
  assert.notEqual(address, null);
}
