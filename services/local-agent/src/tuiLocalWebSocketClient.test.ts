import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { WebSocket } from 'ws';
import {
  TuiLocalWebSocketClient,
  type TuiLocalWebSocketClientHandlers,
} from './tui/tuiLocalWebSocketClient';

class FakeWebSocket extends EventEmitter {
  readyState: number = WebSocket.CONNECTING;
  sent: unknown[] = [];
  closed = false;

  open() {
    this.readyState = WebSocket.OPEN;
    this.emit('open');
  }

  send(data: string) {
    this.sent.push(JSON.parse(data) as unknown);
  }

  close() {
    this.closed = true;
    this.readyState = WebSocket.CLOSED;
    this.emit('close');
  }
}

test('TuiLocalWebSocketClient connects, sends messages, and dispatches socket events', () => {
  const sockets: FakeWebSocket[] = [];
  const urls: string[] = [];
  const events: string[] = [];
  const client = new TuiLocalWebSocketClient({
    port: 3210,
    handlers: createHandlers(events),
    tokenProvider: () => 'secret',
    webSocketFactory: (url) => {
      urls.push(url);
      const ws = new FakeWebSocket();
      sockets.push(ws);
      return ws as unknown as WebSocket;
    },
  });

  client.connect();

  assert.deepEqual(urls, ['ws://127.0.0.1:3210/?token=secret']);
  assert.equal(client.hasSocket(), true);
  assert.equal(client.isConnected(), false);
  assert.equal(client.send({ type: 'new_session' }), false);

  sockets[0]?.open();

  assert.equal(client.isConnected(), true);
  assert.equal(client.send({ type: 'new_session' }), true);
  assert.deepEqual(sockets[0]?.sent, [{ type: 'new_session' }]);

  sockets[0]?.emit('message', JSON.stringify({ type: 'pong' }));
  sockets[0]?.emit('message', '{bad json');
  sockets[0]?.emit('message', JSON.stringify({
    type: 'tool_log',
    requestId: 'legacy',
    toolName: 'read_file',
  }));
  sockets[0]?.emit('error', new Error('boom'));
  sockets[0]?.close();

  assert.deepEqual(events, ['open', 'message:pong', 'error:boom', 'close']);
  assert.equal(client.hasSocket(), false);
  assert.equal(client.isConnected(), false);
});

test('TuiLocalWebSocketClient disconnects current socket without dispatching close', () => {
  const sockets: FakeWebSocket[] = [];
  const events: string[] = [];
  const client = new TuiLocalWebSocketClient({
    port: 3210,
    handlers: createHandlers(events),
    webSocketFactory: () => {
      const ws = new FakeWebSocket();
      sockets.push(ws);
      return ws as unknown as WebSocket;
    },
  });

  client.connect();
  sockets[0]?.open();
  client.disconnect();

  assert.equal(sockets[0]?.closed, true);
  assert.deepEqual(events, ['open']);
  assert.equal(client.hasSocket(), false);

  client.connect();
  assert.equal(sockets.length, 2);
  sockets[0]?.emit('message', 'stale');
  sockets[1]?.open();

  assert.deepEqual(events, ['open', 'open']);
});

function createHandlers(events: string[]): TuiLocalWebSocketClientHandlers {
  return {
    onOpen: () => {
      events.push('open');
    },
    onServerMessage: (message) => {
      events.push(`message:${message.type}`);
    },
    onClose: () => {
      events.push('close');
    },
    onError: (err) => {
      events.push(`error:${err.message}`);
    },
  };
}
