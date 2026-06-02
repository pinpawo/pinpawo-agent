import WebSocket from 'ws';
import {
  parseLocalAgentServerMessage,
  sendLocalAgentMessage,
  type LocalAgentClientMessage,
  type LocalAgentServerMessage,
} from '../localAgentProtocol';

export type TuiLocalWebSocketClientHandlers = {
  onOpen: () => void;
  onServerMessage: (message: LocalAgentServerMessage) => void;
  onClose: () => void;
  onError: (error: Error) => void;
};

export type TuiLocalWebSocketClientOptions = {
  port: number;
  handlers: TuiLocalWebSocketClientHandlers;
  webSocketFactory?: (url: string) => WebSocket;
};

export class TuiLocalWebSocketClient {
  private readonly webSocketFactory: (url: string) => WebSocket;
  private ws: WebSocket | null = null;

  constructor(private readonly options: TuiLocalWebSocketClientOptions) {
    this.webSocketFactory = options.webSocketFactory ?? ((url) => new WebSocket(url));
  }

  connect() {
    this.disconnect();
    const ws = this.webSocketFactory(`ws://127.0.0.1:${this.options.port}`);
    this.ws = ws;

    ws.on('open', () => {
      if (this.ws !== ws) {
        ws.close();
        return;
      }
      this.options.handlers.onOpen();
    });

    ws.on('message', (data) => {
      if (this.ws !== ws) return;
      const message = parseLocalAgentServerMessage(data);
      if (message) {
        this.options.handlers.onServerMessage(message);
      }
    });

    ws.on('close', () => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.options.handlers.onClose();
    });

    ws.on('error', (err) => {
      if (this.ws !== ws) return;
      this.options.handlers.onError(err);
    });
  }

  disconnect() {
    const ws = this.ws;
    if (!ws) return;
    this.ws = null;
    ws.removeAllListeners();
    ws.close();
  }

  send(message: LocalAgentClientMessage) {
    const ws = this.getOpenSocket();
    return ws ? sendLocalAgentMessage(ws, message) : false;
  }

  isConnected() {
    return Boolean(this.getOpenSocket());
  }

  hasSocket() {
    return Boolean(this.ws);
  }

  private getOpenSocket() {
    return this.ws?.readyState === WebSocket.OPEN ? this.ws : null;
  }
}
