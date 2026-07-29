import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import {
  parseAgentServerMessage,
  type AgentClientMessage,
  type AgentServerMessage,
} from '@pinpawo/agent-session';

const DEFAULT_LOCAL_SERVER_PORT = 3210;
const DEFAULT_TOKEN_PATH = resolve(homedir(), '.pinpawo', 'local-server-token');
const SOCKET_OPEN = 1;

export type LocalHostConnectionHandlers = {
  onOpen: () => void;
  onMessage: (message: AgentServerMessage) => void;
  onClose: () => void;
  onError: (error: Error) => void;
};

export type AgentHostConnection = {
  connect: () => void;
  disconnect: () => void;
  send: (message: AgentClientMessage) => boolean;
  isConnected: () => boolean;
};

export type AgentHostConnectionFactory = (
  handlers: LocalHostConnectionHandlers,
) => AgentHostConnection;

type SocketEvent = {
  data?: unknown;
  message?: string;
};

type WebSocketLike = {
  readyState: number;
  addEventListener: (type: string, listener: (event: SocketEvent) => void) => void;
  removeEventListener: (type: string, listener: (event: SocketEvent) => void) => void;
  send: (data: string) => unknown;
  close: () => void;
};

type WebSocketFactory = (
  url: string,
  options: { headers: Record<string, string> },
) => WebSocketLike;

export type LocalHostConnectionOptions = {
  port?: number;
  tokenProvider?: () => string | null;
  webSocketFactory?: WebSocketFactory;
};

export function readLocalServerToken(path = DEFAULT_TOKEN_PATH) {
  try {
    return readFileSync(path, 'utf8').trim() || null;
  } catch {
    return null;
  }
}

export function readLocalServerPort(value = process.env.LOCAL_SERVER_PORT) {
  if (value === undefined || value.trim() === '') {
    return DEFAULT_LOCAL_SERVER_PORT;
  }
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`invalid LOCAL_SERVER_PORT: ${value}`);
  }
  return port;
}

export class LocalHostConnection implements AgentHostConnection {
  private readonly tokenProvider: () => string | null;
  private readonly webSocketFactory: WebSocketFactory;
  private socket: WebSocketLike | null = null;
  private removeSocketListeners: (() => void) | null = null;

  constructor(
    private readonly handlers: LocalHostConnectionHandlers,
    private readonly options: LocalHostConnectionOptions = {},
  ) {
    this.tokenProvider = options.tokenProvider ?? (() => readLocalServerToken());
    this.webSocketFactory = options.webSocketFactory ?? createBunWebSocket;
  }

  connect() {
    this.disconnect();
    const token = this.tokenProvider();
    if (!token) {
      this.handlers.onError(new Error(
        'local-agent auth token is unavailable; start `pinpawo run` first',
      ));
      this.handlers.onClose();
      return;
    }

    let socket: WebSocketLike;
    try {
      socket = this.webSocketFactory(
        `ws://127.0.0.1:${this.options.port ?? DEFAULT_LOCAL_SERVER_PORT}`,
        { headers: { Authorization: `Bearer ${token}` } },
      );
    } catch (error) {
      this.handlers.onError(toError(error));
      this.handlers.onClose();
      return;
    }
    this.socket = socket;
    let messageQueue = Promise.resolve();

    const onOpen = () => {
      if (this.socket === socket) {
        this.handlers.onOpen();
      }
    };
    const onMessage = (event: SocketEvent) => {
      if (this.socket !== socket) return;
      messageQueue = messageQueue
        .then(async () => {
          if (this.socket !== socket) return;
          const raw = await normalizeMessageData(event.data);
          if (this.socket !== socket) return;
          const message = parseAgentServerMessage(raw);
          if (message) {
            this.handlers.onMessage(message);
          } else {
            this.failSocket(
              socket,
              new Error('local-agent sent an invalid protocol message'),
            );
          }
        })
        .catch((error) => {
          if (this.socket === socket) {
            this.failSocket(socket, toError(error));
          }
        });
    };
    const onClose = () => {
      if (this.socket !== socket) return;
      this.detachSocket();
      this.handlers.onClose();
    };
    const onError = (event: SocketEvent) => {
      if (this.socket === socket) {
        this.failSocket(
          socket,
          new Error(event.message || 'local-agent websocket error'),
        );
      }
    };

    socket.addEventListener('open', onOpen);
    socket.addEventListener('message', onMessage);
    socket.addEventListener('close', onClose);
    socket.addEventListener('error', onError);
    this.removeSocketListeners = () => {
      socket.removeEventListener('open', onOpen);
      socket.removeEventListener('message', onMessage);
      socket.removeEventListener('close', onClose);
      socket.removeEventListener('error', onError);
    };
  }

  disconnect() {
    const socket = this.socket;
    if (!socket) return;
    this.detachSocket();
    socket.close();
  }

  send(message: AgentClientMessage) {
    const socket = this.socket;
    if (!socket || socket.readyState !== SOCKET_OPEN) {
      return false;
    }
    try {
      socket.send(JSON.stringify(message));
      return true;
    } catch (error) {
      this.failSocket(socket, toError(error));
      return false;
    }
  }

  isConnected() {
    return this.socket?.readyState === SOCKET_OPEN;
  }

  private detachSocket() {
    this.removeSocketListeners?.();
    this.removeSocketListeners = null;
    this.socket = null;
  }

  private failSocket(socket: WebSocketLike, error: Error) {
    if (this.socket !== socket) return;
    this.handlers.onError(error);
    this.detachSocket();
    try {
      socket.close();
    } catch {
      // The connection is already detached; reconnect must not depend on a
      // broken WebSocket implementation accepting close().
    }
    this.handlers.onClose();
  }
}

export function createLocalHostConnectionFactory(
  options: LocalHostConnectionOptions = {},
): AgentHostConnectionFactory {
  return (handlers) => new LocalHostConnection(handlers, options);
}

function createBunWebSocket(
  url: string,
  options: { headers: Record<string, string> },
) {
  const BunWebSocket = WebSocket as unknown as {
    new (
      socketUrl: string,
      socketOptions: { headers: Record<string, string> },
    ): WebSocketLike;
  };
  return new BunWebSocket(url, options);
}

async function normalizeMessageData(data: unknown): Promise<unknown> {
  if (typeof data === 'string') return data;
  if (data instanceof ArrayBuffer) {
    return new TextDecoder().decode(data);
  }
  if (ArrayBuffer.isView(data)) {
    return new TextDecoder().decode(
      new Uint8Array(data.buffer, data.byteOffset, data.byteLength),
    );
  }
  if (data instanceof Blob) {
    return data.text();
  }
  return data;
}

function toError(error: unknown) {
  return error instanceof Error ? error : new Error(String(error));
}
