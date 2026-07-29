import { expect, test } from 'bun:test';
import { LocalHostConnection } from './localHostConnection';

test('Bun websocket client sends bearer auth and shared protocol messages', async () => {
  const receivedByServer: unknown[] = [];
  const authorization: Array<string | null> = [];
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch(request, bunServer) {
      authorization.push(request.headers.get('authorization'));
      if (bunServer.upgrade(request)) {
        return undefined;
      }
      return new Response('upgrade required', { status: 426 });
    },
    websocket: {
      open(socket) {
        socket.send(JSON.stringify({ type: 'pong' }));
      },
      message(_socket, message) {
        receivedByServer.push(JSON.parse(String(message)) as unknown);
      },
    },
  });

  try {
    const opened = Promise.withResolvers<void>();
    const received = Promise.withResolvers<string>();
    const connection = new LocalHostConnection({
      onOpen: () => opened.resolve(),
      onMessage: (message) => received.resolve(message.type),
      onClose: () => undefined,
      onError: (error) => {
        opened.reject(error);
        received.reject(error);
      },
    }, {
      port: server.port,
      tokenProvider: () => 'native-secret',
    });

    connection.connect();
    await opened.promise;
    expect(authorization).toEqual(['Bearer native-secret']);
    expect(await received.promise).toBe('pong');
    expect(connection.send({ type: 'ping' })).toBe(true);
    await Bun.sleep(10);
    expect(receivedByServer).toEqual([{ type: 'ping' }]);
    connection.disconnect();
  } finally {
    await server.stop(true);
  }
});
