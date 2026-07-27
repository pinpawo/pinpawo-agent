import assert from 'node:assert/strict';
import test from 'node:test';
import {
  LocalHostConnection,
  readLocalServerPort,
} from './localHostConnection';

class FakeSocket {
  readyState = 0;
  sent: unknown[] = [];
  closed = false;
  private readonly listeners = new Map<string, Set<(event: { data?: unknown; message?: string }) => void>>();

  addEventListener(type: string, listener: (event: { data?: unknown; message?: string }) => void) {
    const listeners = this.listeners.get(type) ?? new Set();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: string, listener: (event: { data?: unknown; message?: string }) => void) {
    this.listeners.get(type)?.delete(listener);
  }

  send(data: string) {
    this.sent.push(JSON.parse(data) as unknown);
  }

  close() {
    this.closed = true;
    this.readyState = 3;
    this.emit('close');
  }

  emit(type: string, event: { data?: unknown; message?: string } = {}) {
    for (const listener of this.listeners.get(type) ?? []) {
      listener(event);
    }
  }
}

test('LocalHostConnection authenticates, parses shared messages, and sends shared commands', async () => {
  const socket = new FakeSocket();
  const events: string[] = [];
  let url = '';
  let headers: Record<string, string> = {};
  const connection = new LocalHostConnection({
    onOpen: () => events.push('open'),
    onMessage: (message) => events.push(`message:${message.type}`),
    onClose: () => events.push('close'),
    onError: (error) => events.push(`error:${error.message}`),
  }, {
    port: 4321,
    tokenProvider: () => 'secret',
    webSocketFactory: (nextUrl, options) => {
      url = nextUrl;
      headers = options.headers;
      return socket;
    },
  });

  connection.connect();
  socket.readyState = 1;
  socket.emit('open');

  assert.equal(url, 'ws://127.0.0.1:4321');
  assert.deepEqual(headers, { Authorization: 'Bearer secret' });
  assert.equal(connection.isConnected(), true);
  assert.equal(connection.send({ type: 'ping' }), true);
  assert.deepEqual(socket.sent, [{ type: 'ping' }]);

  socket.emit('message', { data: JSON.stringify({ type: 'pong' }) });
  await Promise.resolve();
  assert.deepEqual(events, ['open', 'message:pong']);

  socket.emit('message', { data: '{invalid' });
  await Promise.resolve();
  assert.match(events.at(-1) ?? '', /^error:local-agent sent an invalid protocol message$/);

  socket.emit('close');
  assert.equal(connection.isConnected(), false);
  assert.equal(events.at(-1), 'close');
});

test('LocalHostConnection reports a missing auth token without opening a socket', () => {
  const events: string[] = [];
  let factoryCalled = false;
  const connection = new LocalHostConnection({
    onOpen: () => events.push('open'),
    onMessage: () => events.push('message'),
    onClose: () => events.push('close'),
    onError: (error) => events.push(`error:${error.message}`),
  }, {
    tokenProvider: () => null,
    webSocketFactory: () => {
      factoryCalled = true;
      return new FakeSocket();
    },
  });

  connection.connect();

  assert.equal(factoryCalled, false);
  assert.deepEqual(events, [
    'error:local-agent auth token is unavailable; start `pinpawo run` first',
    'close',
  ]);
});

test('readLocalServerPort validates the configured loopback port', () => {
  assert.equal(readLocalServerPort(undefined), 3210);
  assert.equal(readLocalServerPort('4321'), 4321);
  assert.throws(() => readLocalServerPort('0'), /invalid LOCAL_SERVER_PORT/);
  assert.throws(() => readLocalServerPort('nope'), /invalid LOCAL_SERVER_PORT/);
});
