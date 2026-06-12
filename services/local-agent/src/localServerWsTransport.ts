import type { Server } from 'node:http';
import { WebSocket, WebSocketServer } from 'ws';
import {
  isAllowedLocalServerOrigin,
  isAuthorizedLocalServerRequest,
} from './localServerAuth';
import {
  parseLocalAgentClientMessage,
  readLocalAgentClientMessageEnvelope,
  sendLocalAgentEvent,
  sendLocalAgentMessage,
  type ChatRequestMessage,
  type HumanReviewResponseMessage,
  type InterruptRequestMessage,
  type NewSessionMessage,
  type StudioRequestMessage,
} from './localAgentProtocol';

type MaybePromise<T> = T | Promise<T>;
type LogError = (message: string, error: unknown) => void;
type LogWarn = (message: string) => void;

export type LocalServerWsHandlers = {
  onChatRequest: (ws: WebSocket, message: ChatRequestMessage) => MaybePromise<void>;
  onStudioRequest: (ws: WebSocket, message: StudioRequestMessage) => MaybePromise<void>;
  onHumanReviewResponse: (ws: WebSocket, message: HumanReviewResponseMessage) => MaybePromise<void>;
  onInterruptRequest: (ws: WebSocket, message: InterruptRequestMessage) => MaybePromise<void>;
  onNewSession: (ws: WebSocket, message: NewSessionMessage) => MaybePromise<void>;
  onClose: (ws: WebSocket) => MaybePromise<void>;
  log?: (message: string) => void;
  logError?: LogError;
  logWarn?: LogWarn;
};

export type LocalServerWsTransportOptions = {
  authToken: string;
  port: number;
};

function defaultLogError(message: string, error: unknown) {
  console.error(message, error instanceof Error ? error.message : error);
}

function defaultLogWarn(message: string) {
  console.warn(message);
}

function formatMalformedClientMessage(prefix: string, data: Buffer | string) {
  const envelope = readLocalAgentClientMessageEnvelope(data);
  return `${prefix} ignored malformed client message `
    + `type=${envelope?.type ?? 'unknown'} requestId=${envelope?.requestId ?? 'unknown'}`;
}

function sendMalformedClientMessageError(ws: WebSocket, data: Buffer | string) {
  const envelope = readLocalAgentClientMessageEnvelope(data);
  if (!envelope?.requestId) {
    return;
  }
  sendLocalAgentEvent(ws, {
    type: 'error',
    requestId: envelope.requestId,
    message: '客户端消息协议不兼容或格式无效，请升级客户端后重试。',
  });
}

function runHandler(
  name: string,
  handler: () => MaybePromise<void>,
  logError: LogError,
) {
  Promise.resolve()
    .then(handler)
    .catch((err) => {
      logError(`[local-server] ${name} error:`, err);
    });
}

export function dispatchLocalServerWebSocketMessage(
  ws: WebSocket,
  data: Buffer | string,
  handlers: LocalServerWsHandlers,
  logError: LogError = handlers.logError ?? defaultLogError,
  logWarn: LogWarn = handlers.logWarn ?? defaultLogWarn,
) {
  try {
    const msg = parseLocalAgentClientMessage(data);
    if (!msg) {
      logWarn(formatMalformedClientMessage('[local-server]', data));
      sendMalformedClientMessageError(ws, data);
      return;
    }

    if (msg.type === 'chat_request') {
      runHandler('handleChatRequest', () => handlers.onChatRequest(ws, msg), logError);
    } else if (msg.type === 'studio_request') {
      runHandler('handleStudioRequest', () => handlers.onStudioRequest(ws, msg), logError);
    } else if (msg.type === 'human_review_response') {
      runHandler('handleHumanReviewResponse', () => handlers.onHumanReviewResponse(ws, msg), logError);
    } else if (msg.type === 'interrupt_request') {
      runHandler('handleInterruptRequest', () => handlers.onInterruptRequest(ws, msg), logError);
    } else if (msg.type === 'new_session') {
      runHandler('handleNewSession', () => handlers.onNewSession(ws, msg), logError);
    } else if (msg.type === 'ping') {
      sendLocalAgentMessage(ws, { type: 'pong' });
    }
  } catch (err) {
    logError('[local-server] failed to dispatch websocket message:', err);
  }
}

export function attachLocalServerWebSocketTransport(
  server: Server,
  handlers: LocalServerWsHandlers,
  options: LocalServerWsTransportOptions,
) {
  const log = handlers.log ?? console.log;
  const logError = handlers.logError ?? defaultLogError;
  const logWarn = handlers.logWarn ?? defaultLogWarn;
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
    log('[local-server] TUI client connected');

    ws.on('message', (data: Buffer | string) => {
      dispatchLocalServerWebSocketMessage(ws, data, handlers, logError, logWarn);
    });

    ws.on('close', () => {
      runHandler('handleClose', () => handlers.onClose(ws), logError);
      log('[local-server] TUI client disconnected');
    });

    ws.on('error', (err) => {
      console.warn('[local-server] WS error:', err.message);
    });
  });

  return wss;
}
