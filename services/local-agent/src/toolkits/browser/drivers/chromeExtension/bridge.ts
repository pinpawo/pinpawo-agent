import { timingSafeEqual, randomBytes, randomUUID } from 'node:crypto';
import {
  chmod,
  mkdir,
  readFile,
  rename,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { connect, createServer, type Server, type Socket } from 'node:net';
import {
  BROWSER_EXTENSION_PROTOCOL_VERSION,
  type BrowserCommandMessage,
  type BrowserCancelMessage,
  type BrowserExtensionCapability,
  type BrowserExtensionCommandName,
  type BrowserRegisterMessage,
  type BrowserResultMessage,
  parseBridgeHelloMessage,
  parseExtensionToAgentMessage,
} from './protocol';

const DEFAULT_COMMAND_TIMEOUT_MS = 30_000;
const MAX_BRIDGE_LINE_BYTES = 4 * 1024 * 1024;

export const DEFAULT_BROWSER_BRIDGE_SOCKET_PATH = resolve(
  homedir(),
  '.pinpawo',
  'run',
  'browser-bridge.sock',
);
export const DEFAULT_BROWSER_BRIDGE_TOKEN_PATH = resolve(
  homedir(),
  '.pinpawo',
  'run',
  'browser-bridge.token',
);

export type BrowserBridgeStatus = {
  listening: boolean;
  hostConnected: boolean;
  extensionConnected: boolean;
  debuggerAttached: boolean;
  targetAlive: boolean;
  connectionId: string | null;
  extensionId: string | null;
  activeTabId: number | null;
  activeTabOwnership: 'agent' | 'user' | null;
  userBoundOrigin: string | null;
  stateRevision: number | null;
  capabilities: BrowserExtensionCapability[];
  socketPath: string;
};

type PendingCommand = {
  connectionId: string;
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
  signal?: AbortSignal;
  abortHandler?: () => void;
};

type BridgeLogger = Pick<Console, 'info' | 'warn' | 'error'>;

export type LocalAgentBrowserBridgeOptions = {
  socketPath?: string;
  tokenPath?: string;
  commandTimeoutMs?: number;
  logger?: BridgeLogger;
  tokenFactory?: () => string;
};

export class BrowserBridgeError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly retryable = false,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'BrowserBridgeError';
  }
}

function serializeLine(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}

function tokensEqual(actual: string, expected: string): boolean {
  const actualBytes = Buffer.from(actual);
  const expectedBytes = Buffer.from(expected);
  return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes);
}

async function unlinkIfPresent(path: string) {
  await unlink(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'ENOENT') throw error;
  });
}

async function isSocketAcceptingConnections(path: string): Promise<boolean> {
  return await new Promise<boolean>((resolvePromise) => {
    const socket = connect(path);
    socket.once('connect', () => {
      socket.destroy();
      resolvePromise(true);
    });
    socket.once('error', () => {
      socket.destroy();
      resolvePromise(false);
    });
  });
}

export class LocalAgentBrowserBridge {
  private readonly socketPath: string;
  private readonly tokenPath: string;
  private readonly commandTimeoutMs: number;
  private readonly logger: BridgeLogger;
  private readonly tokenFactory: () => string;
  private server: Server | null = null;
  private activeSocket: Socket | null = null;
  private token: string | null = null;
  private registration: BrowserRegisterMessage | null = null;
  private debuggerAttached = false;
  private targetAlive = false;
  private readonly pending = new Map<string, PendingCommand>();

  constructor(options: LocalAgentBrowserBridgeOptions = {}) {
    this.socketPath = options.socketPath ?? DEFAULT_BROWSER_BRIDGE_SOCKET_PATH;
    this.tokenPath = options.tokenPath ?? DEFAULT_BROWSER_BRIDGE_TOKEN_PATH;
    this.commandTimeoutMs = options.commandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
    this.logger = options.logger ?? console;
    this.tokenFactory = options.tokenFactory ?? (() => randomBytes(32).toString('hex'));
  }

  getStatus(): BrowserBridgeStatus {
    const activeTab = this.registration?.state?.activeTab
      ?? this.registration?.activeTab;
    const hostConnected = this.activeSocket !== null && !this.activeSocket.destroyed;
    const extensionConnected = this.registration !== null;
    return {
      listening: this.server?.listening ?? false,
      hostConnected,
      extensionConnected,
      debuggerAttached: this.debuggerAttached,
      targetAlive: this.targetAlive,
      connectionId: this.registration?.connectionId ?? null,
      extensionId: this.registration?.extensionId ?? null,
      activeTabId: activeTab?.tabId ?? null,
      activeTabOwnership: activeTab?.ownership ?? null,
      userBoundOrigin: this.registration?.state?.userBoundOrigin ?? null,
      stateRevision: this.registration?.state?.revision ?? null,
      capabilities: [...(this.registration?.capabilities ?? [])],
      socketPath: this.socketPath,
    };
  }

  async start(): Promise<void> {
    if (this.server?.listening) return;

    let socketPathPrepared = false;
    let tokenPathPrepared = false;
    const temporaryTokenPath = `${this.tokenPath}.${process.pid}.tmp`;
    try {
      await mkdir(dirname(this.socketPath), { recursive: true, mode: 0o700 });
      await chmod(dirname(this.socketPath), 0o700);
      if (dirname(this.tokenPath) !== dirname(this.socketPath)) {
        await mkdir(dirname(this.tokenPath), { recursive: true, mode: 0o700 });
        await chmod(dirname(this.tokenPath), 0o700);
      }
      if (await isSocketAcceptingConnections(this.socketPath)) {
        throw new BrowserBridgeError(
          'browser_bridge_already_running',
          `another local-agent browser bridge is already listening at ${this.socketPath}`,
        );
      }
      await unlinkIfPresent(this.socketPath);
      socketPathPrepared = true;

      this.token = this.tokenFactory();
      await writeFile(temporaryTokenPath, `${this.token}\n`, { mode: 0o600 });
      await chmod(temporaryTokenPath, 0o600);
      await rename(temporaryTokenPath, this.tokenPath);
      tokenPathPrepared = true;

      const server = createServer((socket) => this.acceptSocket(socket));
      this.server = server;
      await new Promise<void>((resolvePromise, rejectPromise) => {
        const handleError = (error: Error) => {
          server.off('listening', handleListening);
          rejectPromise(error);
        };
        const handleListening = () => {
          server.off('error', handleError);
          resolvePromise();
        };
        server.once('error', handleError);
        server.once('listening', handleListening);
        server.listen(this.socketPath);
      });
      await chmod(this.socketPath, 0o600);
      this.logger.info(`[browser-bridge] listening on ${this.socketPath}`);
    } catch (error) {
      if (this.server) {
        await this.stop();
      } else {
        await Promise.allSettled([
          unlinkIfPresent(temporaryTokenPath),
          ...(tokenPathPrepared ? [unlinkIfPresent(this.tokenPath)] : []),
          ...(socketPathPrepared ? [unlinkIfPresent(this.socketPath)] : []),
        ]);
        this.token = null;
      }
      throw error;
    }
  }

  async stop(): Promise<void> {
    this.rejectPending(new BrowserBridgeError(
      'browser_bridge_stopped',
      'browser extension bridge stopped',
      true,
    ));
    this.activeSocket?.destroy();
    this.activeSocket = null;
    this.registration = null;
    this.debuggerAttached = false;
    this.targetAlive = false;
    const server = this.server;
    this.server = null;
    if (server?.listening) {
      await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()));
    }
    await Promise.all([
      unlinkIfPresent(this.socketPath),
      unlinkIfPresent(this.tokenPath),
    ]);
    this.token = null;
  }

  async sendCommand(
    command: BrowserExtensionCommandName,
    params: Record<string, unknown>,
    timeoutMs = this.commandTimeoutMs,
    signal?: AbortSignal,
  ): Promise<unknown> {
    if (signal?.aborted) {
      throw new BrowserBridgeError(
        'browser_command_cancelled',
        'Browser command was cancelled before dispatch.',
        true,
      );
    }
    const socket = this.activeSocket;
    const registration = this.registration;
    if (!socket || socket.destroyed || !registration) {
      throw new BrowserBridgeError(
        'browser_extension_disconnected',
        'Chrome extension is not connected. Install/enable the PinPawo extension and retry.',
        true,
      );
    }
    if (!registration.capabilities.includes(command)) {
      throw new BrowserBridgeError(
        'browser_extension_unsupported',
        `Chrome extension does not support ${command}`,
      );
    }
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      throw new Error('browser extension command timeout must be positive');
    }

    const requestId = randomUUID();
    const deadlineAt = new Date(Date.now() + timeoutMs).toISOString();
    const message: BrowserCommandMessage = {
      type: 'browser.command',
      protocolVersion: BROWSER_EXTENSION_PROTOCOL_VERSION,
      connectionId: registration.connectionId,
      requestId,
      command,
      deadlineAt,
      params,
    };

    return await new Promise<unknown>((resolvePromise, rejectPromise) => {
      const timer = setTimeout(() => {
        this.removePending(requestId);
        rejectPromise(new BrowserBridgeError(
          'browser_command_timeout',
          `Chrome extension command ${command} timed out after ${timeoutMs}ms`,
          true,
        ));
      }, timeoutMs);
      const abortHandler = () => {
        const pending = this.removePending(requestId);
        if (!pending) return;
        const cancellation: BrowserCancelMessage = {
          type: 'browser.cancel',
          protocolVersion: BROWSER_EXTENSION_PROTOCOL_VERSION,
          connectionId: registration.connectionId,
          requestId,
        };
        if (!socket.destroyed) {
          socket.write(serializeLine(cancellation), () => {});
        }
        pending.reject(new BrowserBridgeError(
          'browser_command_cancelled',
          'Browser command was cancelled.',
          true,
        ));
      };
      this.pending.set(requestId, {
        connectionId: registration.connectionId,
        resolve: resolvePromise,
        reject: rejectPromise,
        timer,
        signal,
        abortHandler,
      });
      signal?.addEventListener('abort', abortHandler, { once: true });
      socket.write(serializeLine(message), (error) => {
        if (!error) return;
        const pending = this.removePending(requestId);
        if (!pending) return;
        pending.reject(new BrowserBridgeError(
          'browser_bridge_write_failed',
          `failed to send Chrome extension command: ${error.message}`,
          true,
        ));
      });
    });
  }

  private acceptSocket(socket: Socket) {
    socket.setEncoding('utf8');
    let authenticated = false;
    let buffer = '';
    let bufferedBytes = 0;

    const closeUnauthenticated = (message: string) => {
      this.logger.warn(`[browser-bridge] ${message}`);
      socket.destroy();
    };

    socket.on('data', (chunk) => {
      const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      bufferedBytes += Buffer.byteLength(text);
      if (bufferedBytes > MAX_BRIDGE_LINE_BYTES) {
        closeUnauthenticated(`message exceeds ${MAX_BRIDGE_LINE_BYTES} bytes`);
        return;
      }
      buffer += text;
      let newline = buffer.indexOf('\n');
      while (newline >= 0 && !socket.destroyed) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        bufferedBytes = Buffer.byteLength(buffer);
        if (line) {
          try {
            const value = JSON.parse(line) as unknown;
            if (!authenticated) {
              const hello = parseBridgeHelloMessage(value);
              if (!this.token || !tokensEqual(hello.token, this.token)) {
                closeUnauthenticated('native host authentication failed');
                return;
              }
              authenticated = true;
              if (this.activeSocket && !this.activeSocket.destroyed && this.activeSocket !== socket) {
                this.logger.warn(
                  '[browser-bridge] rejected an additional native host while another extension is active',
                );
                socket.destroy();
                return;
              }
              this.replaceActiveSocket(socket);
              socket.write(serializeLine({
                type: 'bridge.ready',
                protocolVersion: BROWSER_EXTENSION_PROTOCOL_VERSION,
              }));
            } else {
              this.handleExtensionMessage(parseExtensionToAgentMessage(value), socket);
            }
          } catch (error) {
            closeUnauthenticated(
              `invalid native host message: ${error instanceof Error ? error.message : String(error)}`,
            );
            return;
          }
        }
        newline = buffer.indexOf('\n');
      }
    });

    socket.on('error', (error) => {
      this.logger.warn(`[browser-bridge] native host socket error: ${error.message}`);
    });
    socket.on('close', () => {
      if (this.activeSocket === socket) {
        this.activeSocket = null;
        this.registration = null;
        this.debuggerAttached = false;
        this.targetAlive = false;
        this.rejectPending(new BrowserBridgeError(
          'browser_extension_disconnected',
          'Chrome extension disconnected while a command was running',
          true,
        ));
        this.logger.info('[browser-bridge] native host disconnected');
      }
    });
  }

  private replaceActiveSocket(socket: Socket) {
    if (this.activeSocket && this.activeSocket !== socket) {
      this.activeSocket.destroy();
    }
    this.activeSocket = socket;
    this.registration = null;
    this.debuggerAttached = false;
    this.targetAlive = false;
    this.rejectPending(new BrowserBridgeError(
      'browser_connection_replaced',
      'Chrome extension connection was replaced',
      true,
    ));
    this.logger.info('[browser-bridge] native host authenticated');
  }

  private handleExtensionMessage(
    message: ReturnType<typeof parseExtensionToAgentMessage>,
    socket: Socket,
  ) {
    if (socket !== this.activeSocket) return;

    if (message.type === 'browser.register') {
      if (this.registration?.connectionId !== message.connectionId) {
        this.rejectPending(new BrowserBridgeError(
          'browser_connection_replaced',
          'Chrome extension service worker connection changed',
          true,
        ));
      }
      const previousRevision = this.registration?.state?.revision;
      const nextRevision = message.state?.revision;
      if (
        this.registration?.connectionId === message.connectionId
        && previousRevision !== undefined
        && (nextRevision === undefined || nextRevision <= previousRevision)
      ) {
        this.logger.warn(
          `[browser-bridge] ignored stale browser state revision ${nextRevision ?? 'legacy'}; current=${previousRevision}`,
        );
        return;
      }
      this.registration = message;
      const activeTab = message.state?.activeTab ?? message.activeTab;
      this.targetAlive = activeTab !== undefined;
      this.debuggerAttached = message.state?.debuggerAttached ?? false;
      this.logger.info(
        `[browser-bridge] browser.register extension=${message.extensionId} connection=${message.connectionId}`,
      );
      return;
    }

    if (!this.registration || message.connectionId !== this.registration.connectionId) {
      this.logger.warn('[browser-bridge] ignored message from stale extension connection');
      return;
    }

    if (message.type === 'browser.result') {
      this.resolveResult(message);
      return;
    }

    if (this.registration.state) {
      return;
    }

    if (message.event === 'debugger.attached') {
      this.debuggerAttached = true;
      this.targetAlive = true;
    } else if (message.event === 'debugger.detached') {
      this.debuggerAttached = false;
    } else if (message.event === 'target.closed') {
      this.debuggerAttached = false;
      this.targetAlive = false;
    } else if (message.event === 'tab.navigated') {
      this.targetAlive = true;
    }
  }

  private resolveResult(message: BrowserResultMessage) {
    const current = this.pending.get(message.requestId);
    if (!current || current.connectionId !== message.connectionId) return;
    const pending = this.removePending(message.requestId);
    if (!pending) return;
    if (message.ok) {
      pending.resolve(message.result);
      return;
    }
    pending.reject(new BrowserBridgeError(
      message.error!.code,
      message.error!.message,
      message.error!.retryable ?? false,
      message.error!.details,
    ));
  }

  private rejectPending(error: Error) {
    for (const requestId of this.pending.keys()) {
      const pending = this.removePending(requestId);
      if (!pending) continue;
      pending.reject(error);
    }
  }

  private removePending(requestId: string): PendingCommand | undefined {
    const pending = this.pending.get(requestId);
    if (!pending) return undefined;
    this.pending.delete(requestId);
    clearTimeout(pending.timer);
    pending.signal?.removeEventListener('abort', pending.abortHandler!);
    return pending;
  }
}

export async function readBrowserBridgeToken(
  tokenPath = DEFAULT_BROWSER_BRIDGE_TOKEN_PATH,
): Promise<string> {
  return (await readFile(tokenPath, 'utf8')).trim();
}

export const localAgentBrowserBridge = new LocalAgentBrowserBridge();
