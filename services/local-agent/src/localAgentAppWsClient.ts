import { WebSocket } from 'ws';
import {
  parseLocalAgentClientMessage,
  readLocalAgentClientMessageEnvelope,
  sendLocalAgentEvent,
  sendLocalAgentMessage,
  type ChatRequestMessage,
  type HumanReviewResponseMessage,
  type NewSessionMessage,
  type ReviewCancelMessage,
  type RunInterruptMessage,
  type StudioRequestMessage,
} from './localAgentProtocol';

type MaybePromise<T> = T | Promise<T>;
type Log = (message: string) => void;
type LogError = (message: string, error: unknown) => void;
type LogWarn = (message: string, error?: unknown) => void;

export type LocalAgentAppWsClientHandlers = {
  onChatRequest: (ws: WebSocket, message: ChatRequestMessage) => MaybePromise<void>;
  onStudioRequest: (ws: WebSocket, message: StudioRequestMessage) => MaybePromise<void>;
  onNewSession: (ws: WebSocket, message: NewSessionMessage) => MaybePromise<void>;
  onReviewCancel: (ws: WebSocket, message: ReviewCancelMessage) => MaybePromise<void>;
  onRunInterrupt: (ws: WebSocket, message: RunInterruptMessage) => MaybePromise<void>;
  onHumanReviewResponse: (ws: WebSocket, message: HumanReviewResponseMessage) => MaybePromise<void>;
  onClose: (ws: WebSocket) => MaybePromise<void>;
};

export type LocalAgentAppWsClientOptions = {
  actorId: string;
  url: string;
  handlers: LocalAgentAppWsClientHandlers;
  reconnectDelayMs: number;
  pingIntervalMs: number;
  webSocketFactory?: (url: string) => WebSocket;
  log?: Log;
  logError?: LogError;
  logWarn?: LogWarn;
};

function defaultLogError(message: string, error: unknown) {
  console.error(message, error instanceof Error ? error.message : error);
}

function defaultLogWarn(message: string, error?: unknown) {
  if (error === undefined) {
    console.warn(message);
    return;
  }
  console.warn(message, error instanceof Error ? error.message : error);
}

function formatMalformedClientMessage(data: Buffer | string) {
  const envelope = readLocalAgentClientMessageEnvelope(data);
  return '[local-agent] ignored malformed app client message '
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
      logError(`[local-agent] ${name} error:`, err);
    });
}

export function dispatchLocalAgentAppWebSocketMessage(
  ws: WebSocket,
  data: Buffer | string,
  handlers: LocalAgentAppWsClientHandlers,
  logError: LogError = defaultLogError,
  logWarn: LogWarn = defaultLogWarn,
) {
  try {
    const msg = parseLocalAgentClientMessage(data);
    if (!msg) {
      logWarn(formatMalformedClientMessage(data));
      sendMalformedClientMessageError(ws, data);
      return;
    }

    if (msg.type === 'chat_request') {
      runHandler('handleChatRequest', () => handlers.onChatRequest(ws, msg), logError);
    } else if (msg.type === 'studio_request') {
      runHandler('handleStudioRequest', () => handlers.onStudioRequest(ws, msg), logError);
    } else if (msg.type === 'new_session') {
      runHandler('handleNewSession', () => handlers.onNewSession(ws, msg), logError);
    } else if (msg.type === 'review.cancel') {
      runHandler('handleReviewCancel', () => handlers.onReviewCancel(ws, msg), logError);
    } else if (msg.type === 'run.interrupt') {
      runHandler('handleRunInterrupt', () => handlers.onRunInterrupt(ws, msg), logError);
    } else if (msg.type === 'human_review_response') {
      runHandler('handleHumanReviewResponse', () => handlers.onHumanReviewResponse(ws, msg), logError);
    } else if (msg.type === 'ping') {
      sendLocalAgentMessage(ws, { type: 'pong' });
    }
  } catch (err) {
    logError('[local-agent] failed to dispatch app websocket message:', err);
  }
}

export class LocalAgentAppWsClient {
  private readonly actorId: string;
  private readonly url: string;
  private readonly handlers: LocalAgentAppWsClientHandlers;
  private readonly reconnectDelayMs: number;
  private readonly pingIntervalMs: number;
  private readonly webSocketFactory: (url: string) => WebSocket;
  private readonly log: Log;
  private readonly logError: LogError;
  private readonly logWarn: LogWarn;
  private ws: WebSocket | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private pingInterval: ReturnType<typeof setInterval> | null = null;
  private stopped = false;

  constructor(options: LocalAgentAppWsClientOptions) {
    this.actorId = options.actorId;
    this.url = options.url;
    this.handlers = options.handlers;
    this.reconnectDelayMs = options.reconnectDelayMs;
    this.pingIntervalMs = options.pingIntervalMs;
    this.webSocketFactory = options.webSocketFactory ?? ((url) => new WebSocket(url));
    this.log = options.log ?? console.log;
    this.logError = options.logError ?? defaultLogError;
    this.logWarn = options.logWarn ?? defaultLogWarn;
  }

  connect() {
    if (this.stopped) return;
    this.clearReconnectTimer();
    this.clearPing();

    this.log(`[local-agent] connecting WS... actorId=${this.actorId}`);

    const ws = this.webSocketFactory(this.url);
    this.ws = ws;

    ws.on('open', () => {
      this.log('[local-agent] WS connected');
      this.pingInterval = setInterval(() => {
        sendLocalAgentMessage(ws, { type: 'pong' });
      }, this.pingIntervalMs);
    });

    ws.on('message', (data: Buffer | string) => {
      dispatchLocalAgentAppWebSocketMessage(ws, data, this.handlers, this.logError, this.logWarn);
    });

    ws.on('close', (code, reason) => {
      const detail = reason.length > 0 ? ` reason=${reason.toString()}` : '';
      this.log(`[local-agent] WS disconnected code=${code}${detail}`);
      this.clearPing();
      runHandler('handleClose', () => this.handlers.onClose(ws), this.logError);
      this.scheduleReconnect();
    });

    ws.on('error', (err: Error) => {
      this.logWarn('[local-agent] WS error:', err);
      this.clearPing();
    });
  }

  disconnect() {
    this.stopped = true;
    this.clearReconnectTimer();
    this.clearPing();
    if (this.ws) {
      this.ws.removeAllListeners();
      this.ws.close();
      this.ws = null;
    }
  }

  getCurrentSocket() {
    return this.ws;
  }

  isCurrentSocket(ws: WebSocket) {
    return this.ws === ws;
  }

  private clearReconnectTimer() {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private clearPing() {
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
      this.pingInterval = null;
    }
  }

  private scheduleReconnect() {
    if (this.stopped) return;
    this.clearReconnectTimer();
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, this.reconnectDelayMs);
  }
}
