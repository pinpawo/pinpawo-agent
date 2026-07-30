import type { Readable, Writable } from 'node:stream';
import { connect, type Socket } from 'node:net';
import {
  BROWSER_EXTENSION_PROTOCOL_VERSION,
  parseAgentToExtensionMessage,
  parseExtensionToAgentMessage,
  type BrowserRegisterMessage,
} from '../protocol';
import {
  DEFAULT_BROWSER_BRIDGE_SOCKET_PATH,
  DEFAULT_BROWSER_BRIDGE_TOKEN_PATH,
  readBrowserBridgeToken,
} from '../bridge';
import { encodeNativeMessage, NativeMessageDecoder } from './framing';

const RECONNECT_DELAY_MS = 1_000;
const MAX_SOCKET_LINE_BYTES = 4 * 1024 * 1024;

type NativeHostLogger = Pick<Console, 'error'>;

export type NativeHostOptions = {
  input?: Readable;
  output?: Writable;
  socketPath?: string;
  tokenPath?: string;
  logger?: NativeHostLogger;
  reconnectDelayMs?: number;
};

export class NativeHostRelay {
  private readonly input: Readable;
  private readonly output: Writable;
  private readonly socketPath: string;
  private readonly tokenPath: string;
  private readonly logger: NativeHostLogger;
  private readonly reconnectDelayMs: number;
  private readonly decoder = new NativeMessageDecoder();
  private socket: Socket | null = null;
  private socketReady = false;
  private socketBuffer = '';
  private reconnectTimer: NodeJS.Timeout | null = null;
  private stopped = false;
  private registration: BrowserRegisterMessage | null = null;

  constructor(options: NativeHostOptions = {}) {
    this.input = options.input ?? process.stdin;
    this.output = options.output ?? process.stdout;
    this.socketPath = options.socketPath ?? DEFAULT_BROWSER_BRIDGE_SOCKET_PATH;
    this.tokenPath = options.tokenPath ?? DEFAULT_BROWSER_BRIDGE_TOKEN_PATH;
    this.logger = options.logger ?? console;
    this.reconnectDelayMs = options.reconnectDelayMs ?? RECONNECT_DELAY_MS;
  }

  start() {
    this.input.on('data', this.handleNativeData);
    this.input.once('end', this.stop);
    this.input.once('error', this.handleInputError);
    void this.connectToAgent();
  }

  stop = () => {
    if (this.stopped) return;
    this.stopped = true;
    this.input.off('data', this.handleNativeData);
    this.input.off('error', this.handleInputError);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.socket?.destroy();
    this.socket = null;
    this.socketReady = false;
  };

  private handleInputError = (error: Error) => {
    this.logger.error(`[pinpawo-native-host] stdin error: ${error.message}`);
    this.stop();
  };

  private handleNativeData = (chunk: Buffer | string) => {
    try {
      for (const value of this.decoder.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))) {
        const message = parseExtensionToAgentMessage(value);
        if (message.type === 'browser.register') this.registration = message;
        if (this.socketReady && this.socket && !this.socket.destroyed) {
          this.socket.write(`${JSON.stringify(message)}\n`);
        } else if (message.type === 'browser.register') {
          // Results and lifecycle events belong to the disconnected bridge
          // epoch. Only the latest full registration is safe to reconcile.
          void this.connectToAgent();
        }
      }
    } catch (error) {
      this.logger.error(
        `[pinpawo-native-host] invalid extension message: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  };

  private async connectToAgent() {
    if (this.stopped || this.socket || this.reconnectTimer) return;
    let token: string;
    try {
      token = await readBrowserBridgeToken(this.tokenPath);
    } catch {
      this.scheduleReconnect();
      return;
    }
    if (this.stopped || this.socket) return;

    const socket = connect(this.socketPath);
    this.socket = socket;
    socket.setEncoding('utf8');
    socket.once('connect', () => {
      socket.write(`${JSON.stringify({
        type: 'bridge.hello',
        protocolVersion: BROWSER_EXTENSION_PROTOCOL_VERSION,
        token,
        hostPid: process.pid,
      })}\n`);
    });
    socket.on('data', (chunk) => this.handleSocketData(
      typeof chunk === 'string' ? chunk : chunk.toString('utf8'),
      socket,
    ));
    socket.on('error', (error) => {
      this.logger.error(`[pinpawo-native-host] local bridge error: ${error.message}`);
    });
    socket.once('close', () => {
      if (this.socket !== socket) return;
      this.socket = null;
      this.socketReady = false;
      this.socketBuffer = '';
      this.scheduleReconnect();
    });
  }

  private handleSocketData(chunk: string, socket: Socket) {
    if (socket !== this.socket) return;
    this.socketBuffer += chunk;
    if (Buffer.byteLength(this.socketBuffer) > MAX_SOCKET_LINE_BYTES) {
      this.logger.error('[pinpawo-native-host] local bridge line exceeded size limit');
      socket.destroy();
      return;
    }
    let newline = this.socketBuffer.indexOf('\n');
    while (newline >= 0) {
      const line = this.socketBuffer.slice(0, newline).trim();
      this.socketBuffer = this.socketBuffer.slice(newline + 1);
      if (line) this.handleSocketLine(line, socket);
      newline = this.socketBuffer.indexOf('\n');
    }
  }

  private handleSocketLine(line: string, socket: Socket) {
    try {
      const value = JSON.parse(line) as unknown;
      if (
        typeof value === 'object'
        && value !== null
        && (value as Record<string, unknown>).type === 'bridge.ready'
      ) {
        if ((value as Record<string, unknown>).protocolVersion !== BROWSER_EXTENSION_PROTOCOL_VERSION) {
          throw new Error('local bridge protocol version mismatch');
        }
        this.socketReady = true;
        if (this.registration) {
          socket.write(`${JSON.stringify(this.registration)}\n`);
        }
        return;
      }
      const message = parseAgentToExtensionMessage(value);
      this.output.write(encodeNativeMessage(message));
    } catch (error) {
      this.logger.error(
        `[pinpawo-native-host] invalid local bridge message: ${error instanceof Error ? error.message : String(error)}`,
      );
      socket.destroy();
    }
  }

  private scheduleReconnect() {
    if (this.stopped || this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.connectToAgent();
    }, this.reconnectDelayMs);
    this.reconnectTimer.unref();
  }
}

export function runNativeHost(options: NativeHostOptions = {}) {
  const relay = new NativeHostRelay(options);
  relay.start();
  return relay;
}
