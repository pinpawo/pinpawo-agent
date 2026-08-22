import type { Server } from 'node:http';
import { WebSocket, WebSocketServer } from 'ws';
import {
  isAllowedLocalServerOrigin,
  isAuthorizedLocalServerRequest,
} from './localServerAuth';
import {
  createLocalAgentWireHandlers,
  defaultLocalServerLogError,
  type LocalServerLogError,
  type LocalServerTransportHandlers,
} from './localServerMessageDispatcher';
import type { LocalServerPeer } from './localServerPeer';
import {
  defaultLocalServerWireLogError,
  runLocalServerWireHandler,
  type LocalServerWireHandlers,
  type LocalServerWirePeer,
} from './localServerWire';

export type LocalServerWsTransportOptions = {
  authToken: string;
  port: number;
};

export function createLocalServerWireWebSocketPeer<TMessage extends object>(
  ws: WebSocket,
  logError: LocalServerLogError = defaultLocalServerWireLogError,
): LocalServerWirePeer<TMessage> {
  return {
    isConnected: () => ws.readyState === WebSocket.OPEN,
    send: (message) => {
      try {
        if (ws.readyState !== WebSocket.OPEN) return false;
        ws.send(JSON.stringify(message));
        return true;
      } catch (err) {
        logError('[local-server] failed to send websocket message:', err);
        return false;
      }
    },
  };
}

export function createLocalServerWebSocketPeer(
  ws: WebSocket,
  logError: LocalServerLogError = defaultLocalServerLogError,
): LocalServerPeer {
  return createLocalServerWireWebSocketPeer(ws, logError);
}

export function attachLocalServerWireWebSocketTransport<TMessage extends object>(
  server: Server,
  handlers: LocalServerWireHandlers<TMessage>,
  options: LocalServerWsTransportOptions,
) {
  const log = handlers.log ?? console.log;
  const logError = handlers.logError ?? defaultLocalServerWireLogError;
  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (req, socket, head) => {
    if (!isAllowedLocalServerOrigin(req, options.port)) {
      socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      socket.destroy();
      log('[local-server] rejected WS upgrade from invalid Origin');
      return;
    }

    if (!isAuthorizedLocalServerRequest(req, options.authToken)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
      socket.destroy();
      log('[local-server] rejected WS upgrade without valid token');
      return;
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req);
    });
  });

  wss.on('connection', (ws) => {
    const peer = createLocalServerWireWebSocketPeer<TMessage>(ws, logError);
    log('[local-server] local client connected');

    ws.on('message', (data: Buffer | string) => {
      void runLocalServerWireHandler(
        'handleMessage',
        () => handlers.onMessage(peer, data),
        logError,
      );
    });

    ws.on('close', () => {
      if (handlers.onClose) {
        void runLocalServerWireHandler('handleClose', () => handlers.onClose!(peer), logError);
      }
      log('[local-server] local client disconnected');
    });

    ws.on('error', (err) => {
      console.warn('[local-server] WS error:', err.message);
    });
  });

  return wss;
}

/** Chat/Agent Session adapter retained for the local-agent Host. */
export function attachLocalServerWebSocketTransport(
  server: Server,
  handlers: LocalServerTransportHandlers,
  options: LocalServerWsTransportOptions,
) {
  return attachLocalServerWireWebSocketTransport(
    server,
    createLocalAgentWireHandlers(handlers),
    options,
  );
}
