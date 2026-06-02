import type { Server } from 'node:http';
import { WebSocket, WebSocketServer } from 'ws';
import {
  parseLocalAgentClientMessage,
  sendLocalAgentMessage,
  type ChatRequestMessage,
  type HumanReviewResponseMessage,
  type InterruptRequestMessage,
  type NewSessionMessage,
  type StudioRequestMessage,
} from './localAgentProtocol';

type MaybePromise<T> = T | Promise<T>;
type LogError = (message: string, error: unknown) => void;

export type LocalServerWsHandlers = {
  onChatRequest: (ws: WebSocket, message: ChatRequestMessage) => MaybePromise<void>;
  onStudioRequest: (ws: WebSocket, message: StudioRequestMessage) => MaybePromise<void>;
  onHumanReviewResponse: (ws: WebSocket, message: HumanReviewResponseMessage) => MaybePromise<void>;
  onInterruptRequest: (ws: WebSocket, message: InterruptRequestMessage) => MaybePromise<void>;
  onNewSession: (ws: WebSocket, message: NewSessionMessage) => MaybePromise<void>;
  onClose: (ws: WebSocket) => MaybePromise<void>;
  log?: (message: string) => void;
  logError?: LogError;
};

function defaultLogError(message: string, error: unknown) {
  console.error(message, error instanceof Error ? error.message : error);
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
) {
  try {
    const msg = parseLocalAgentClientMessage(data);
    if (!msg) return;

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
  } catch {
    // ignore malformed messages
  }
}

export function attachLocalServerWebSocketTransport(
  server: Server,
  handlers: LocalServerWsHandlers,
) {
  const log = handlers.log ?? console.log;
  const logError = handlers.logError ?? defaultLogError;
  const wss = new WebSocketServer({ server });

  wss.on('connection', (ws) => {
    log('[local-server] TUI client connected');

    ws.on('message', (data: Buffer | string) => {
      dispatchLocalServerWebSocketMessage(ws, data, handlers, logError);
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
