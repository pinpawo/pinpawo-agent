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
  await flushTasks();
  assert.deepEqual(events, ['open', 'message:pong']);

  socket.emit('message', { data: '{invalid' });
  await flushTasks();
  assert.deepEqual(events.slice(-2), [
    'error:local-agent sent an invalid protocol message',
    'close',
  ]);
  assert.equal(socket.closed, true);
  assert.equal(connection.isConnected(), false);
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

test('LocalHostConnection preserves socket arrival order across async payload decoding', async () => {
  const socket = new FakeSocket();
  const messages: string[] = [];
  const connection = new LocalHostConnection({
    onOpen: () => undefined,
    onMessage: (message) => {
      messages.push(
        'requestId' in message
          ? `${message.type}:${message.requestId}`
          : message.type,
      );
    },
    onClose: () => undefined,
    onError: (error) => assert.fail(error.message),
  }, {
    tokenProvider: () => 'secret',
    webSocketFactory: () => socket,
  });
  const firstText = Promise.withResolvers<string>();
  let secondRead = false;
  const first = blobWithText(() => firstText.promise);
  const second = blobWithText(async () => {
    secondRead = true;
    return JSON.stringify({
      type: 'interrupting',
      requestId: 'second',
    });
  });

  connection.connect();
  socket.readyState = 1;
  socket.emit('open');
  socket.emit('message', { data: first });
  socket.emit('message', { data: second });
  await flushTasks();
  assert.equal(secondRead, false);
  assert.deepEqual(messages, []);

  firstText.resolve(JSON.stringify({
    type: 'interrupting',
    requestId: 'first',
  }));
  await flushTasks();
  assert.equal(secondRead, true);
  assert.deepEqual(messages, [
    'interrupting:first',
    'interrupting:second',
  ]);
  connection.disconnect();
});

test('readLocalServerPort validates the configured loopback port', () => {
  assert.equal(readLocalServerPort(undefined), 3210);
  assert.equal(readLocalServerPort('4321'), 4321);
  assert.throws(() => readLocalServerPort('0'), /invalid LOCAL_SERVER_PORT/);
  assert.throws(() => readLocalServerPort('nope'), /invalid LOCAL_SERVER_PORT/);
});

function blobWithText(read: () => Promise<string>) {
  const blob = new Blob();
  Object.defineProperty(blob, 'text', {
    configurable: true,
    value: read,
  });
  return blob;
}

async function flushTasks() {
  await new Promise<void>((resolve) => setImmediate(resolve));
  await new Promise<void>((resolve) => setImmediate(resolve));
}
