import type { Server } from 'node:http';
import { WebSocket, WebSocketServer } from 'ws';
import {
  isAllowedLocalServerOrigin,
  isAuthorizedLocalServerRequest,
} from './localServerAuth';
import { sendLocalAgentMessage } from './localAgentProtocol';
import {
  defaultLocalServerLogError,
  defaultLocalServerLogWarn,
  dispatchLocalServerMessage,
  runLocalServerPeerHandler,
  type LocalServerLogError,
  type LocalServerPeerHandlers,
} from './localServerMessageDispatcher';
import type { LocalServerPeer } from './localServerPeer';

export type LocalServerWsTransportOptions = {
  authToken: string;
  port: number;
};

export function createLocalServerWebSocketPeer(
  ws: WebSocket,
  logError: LocalServerLogError = defaultLocalServerLogError,
): LocalServerPeer {
  return {
    isConnected: () => ws.readyState === WebSocket.OPEN,
    send: (message) => {
      try {
        return sendLocalAgentMessage(ws, message);
      } catch (err) {
        logError('[local-server] failed to send websocket message:', err);
        return false;
      }
    },
  };
}

export function attachLocalServerWebSocketTransport(
  server: Server,
  handlers: LocalServerPeerHandlers,
  options: LocalServerWsTransportOptions,
) {
  const log = handlers.log ?? console.log;
  const logError = handlers.logError ?? defaultLocalServerLogError;
  const logWarn = handlers.logWarn ?? defaultLocalServerLogWarn;
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
    const peer = createLocalServerWebSocketPeer(ws, logError);
    log('[local-server] TUI client connected');

    ws.on('message', (data: Buffer | string) => {
      dispatchLocalServerMessage(peer, data, handlers, logError, logWarn);
    });

    ws.on('close', () => {
      runLocalServerPeerHandler('handleClose', () => handlers.onClose(peer), logError);
      log('[local-server] TUI client disconnected');
    });

    ws.on('error', (err) => {
      console.warn('[local-server] WS error:', err.message);
    });
  });

  return wss;
}
