import type { Server } from 'node:http';
import { WebSocket, WebSocketServer } from 'ws';
import {
  isAllowedWireOrigin,
  isAuthorizedWireRequest,
} from './wire/auth';
import {
  createHostWireHandlers,
  defaultHostLogError,
  type ServerLogError,
  type ServerTransportHandlers,
} from './wire/messageDispatcher';
import type { ServerPeer } from './wire/peer';
import {
  defaultWireLogError,
  runWireHandler,
  type ServerWireHandlers,
  type ServerWirePeer,
} from './wire/framing';

export type ServerWsTransportOptions = {
  authToken: string;
  port: number;
};

export function createWireWebSocketPeer<TMessage extends object>(
  ws: WebSocket,
  logError: ServerLogError = defaultWireLogError,
): ServerWirePeer<TMessage> {
  return {
    isConnected: () => ws.readyState === WebSocket.OPEN,
    send: (message) => {
      try {
        if (ws.readyState !== WebSocket.OPEN) return false;
        ws.send(JSON.stringify(message));
        return true;
      } catch (err) {
        logError('[wire] failed to send websocket message:', err);
        return false;
      }
    },
  };
}

export function createHostWebSocketPeer(
  ws: WebSocket,
  logError: ServerLogError = defaultHostLogError,
): ServerPeer {
  return createWireWebSocketPeer(ws, logError);
}

export function attachWireWebSocketTransport<TMessage extends object>(
  server: Server,
  handlers: ServerWireHandlers<TMessage>,
  options: ServerWsTransportOptions,
) {
  const log = handlers.log ?? console.log;
  const logError = handlers.logError ?? defaultWireLogError;
  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (req, socket, head) => {
    if (!isAllowedWireOrigin(req, options.port)) {
      socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      socket.destroy();
      log('[wire] rejected WS upgrade from invalid Origin');
      return;
    }

    if (!isAuthorizedWireRequest(req, options.authToken)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
      socket.destroy();
      log('[wire] rejected WS upgrade without valid token');
      return;
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req);
    });
  });

  wss.on('connection', (ws) => {
    const peer = createWireWebSocketPeer<TMessage>(ws, logError);
    log('[wire] local client connected');

    ws.on('message', (data: Buffer | string) => {
      void runWireHandler(
        'handleMessage',
        () => handlers.onMessage(peer, data),
        logError,
      );
    });

    ws.on('close', () => {
      if (handlers.onClose) {
        void runWireHandler('handleClose', () => handlers.onClose!(peer), logError);
      }
      log('[wire] local client disconnected');
    });

    ws.on('error', (err) => {
      console.warn('[wire] WS error:', err.message);
    });
  });

  return wss;
}

/** Chat/Agent Session adapter retained for the Host. */
export function attachHostWebSocketTransport(
  server: Server,
  handlers: ServerTransportHandlers,
  options: ServerWsTransportOptions,
) {
  return attachWireWebSocketTransport(
    server,
    createHostWireHandlers(handlers),
    options,
  );
}
