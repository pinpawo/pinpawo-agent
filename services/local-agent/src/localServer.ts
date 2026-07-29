/**
 * Local HTTP/WebSocket server for TUI ↔ run process communication.
 */
import {
  createServer,
  type Server,
} from 'node:http';
import type { WebSocketServer } from 'ws';
import { ensureLocalServerAuthToken } from './localServerAuth';
import {
  createLocalServerHandlers,
  type LocalServerHandlerOptions,
} from './localServerHandlers';
import type { LocalServerDeps } from './localServerTypes';
import { attachLocalServerWebSocketTransport } from './localServerWsTransport';

export type { LocalServerDeps };

export type LocalServerOptions = {
  authToken?: string;
  handlerOptions?: LocalServerHandlerOptions;
};

export type LocalServerTransport = {
  port: number;
  close: () => void;
  closed: Promise<void>;
};

export async function startLocalServer(
  port: number,
  deps: LocalServerDeps,
  options: LocalServerOptions = {},
): Promise<LocalServerTransport> {
  const handlers = createLocalServerHandlers(deps, options.handlerOptions);
  const authToken = options.authToken ?? ensureLocalServerAuthToken();
  const server = createServer((req, res) => {
    if (handlers.handleHttpRequest(req, res, authToken)) {
      return;
    }
    res.writeHead(404);
    res.end();
  });
  let webSocketServer: WebSocketServer | null = null;

  try {
    await listen(server, port);
    const address = server.address();
    if (!address || typeof address === 'string') {
      throw new Error('local server did not expose a TCP address');
    }
    webSocketServer = attachLocalServerWebSocketTransport(
      server,
      handlers.peerHandlers,
      {
        authToken,
        port: address.port,
      },
    );
    console.log(`[local-server] listening on ws://127.0.0.1:${address.port}`);
    console.log('[local-server] local HTTP/WS auth enabled');

    let requestClose!: () => void;
    let closeRequested = false;
    const closeSignal = new Promise<void>((resolve) => {
      requestClose = resolve;
    });
    const closed = closeSignal.then(async () => {
      const results = await Promise.allSettled([
        closeWebSocketServer(webSocketServer!),
        closeHttpServer(server),
      ]);
      try {
        const failure = results.find((result) => result.status === 'rejected');
        if (failure?.status === 'rejected') {
          throw failure.reason;
        }
      } finally {
        handlers.close();
      }
    });

    return {
      port: address.port,
      close: () => {
        if (closeRequested) return;
        closeRequested = true;
        requestClose();
      },
      closed,
    };
  } catch (error) {
    if (webSocketServer) {
      await closeWebSocketServer(webSocketServer).catch(() => undefined);
    }
    await closeHttpServer(server).catch(() => undefined);
    handlers.close();
    throw error;
  }
}

async function listen(server: Server, port: number) {
  await new Promise<void>((resolve, reject) => {
    const handleError = (error: Error) => {
      server.off('listening', handleListening);
      reject(error);
    };
    const handleListening = () => {
      server.off('error', handleError);
      resolve();
    };
    server.once('error', handleError);
    server.once('listening', handleListening);
    server.listen(port, '127.0.0.1');
  });
}

async function closeWebSocketServer(server: WebSocketServer) {
  for (const client of server.clients) {
    client.terminate();
  }
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

async function closeHttpServer(server: Server) {
  if (!server.listening) return;
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (
        error
        && (error as NodeJS.ErrnoException).code !== 'ERR_SERVER_NOT_RUNNING'
      ) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}
