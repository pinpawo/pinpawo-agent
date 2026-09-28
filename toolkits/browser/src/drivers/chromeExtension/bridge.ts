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
  BROWSER_LEGACY_CONTEXT_ID,
  type BrowserCommandMessage,
  type BrowserCancelMessage,
  type BrowserExtensionCapability,
  type BrowserExtensionCommandName,
  type BrowserRegisterMessage,
  type BrowserResultMessage,
  parseBridgeHelloMessage,
  parseExtensionToAgentMessage,
} from './protocol';
import {
  type BrowserRuntimeEvent,
  type BrowserRuntimeEventType,
} from '../../lifecycle/events';

/**
 * Event types that are scoped to a navigation generation. These are stamped
 * with the active navigation generation so a late event from a superseded
 * navigation (e.g. an SPA route change) cannot mutate the current one.
 * Target/connection-lifecycle events (`target.*`, `debugger.*`,
 * `runtime.disconnected`) carry only connection + target generation and are
 * intentionally not navigation-scoped.
 */
const NAVIGATION_SCOPED_EVENT_TYPES = new Set<BrowserRuntimeEventType>([
  'navigation.requested',
  'navigation.committed',
  'document.ready',
  'network.activity',
  'dom.changed',
  'popup.created',
  'download.started',
  'download.finished',
]);

const DEFAULT_COMMAND_TIMEOUT_MS = 30_000;
const MAX_BRIDGE_LINE_BYTES = 4 * 1024 * 1024;

/**
 * Commands that act on the page. Once one has been written to the extension,
 * the extension may already have dispatched its input even if no result comes
 * back, so an interruption must not invite a blind retry (issue #869).
 * `navigate` is left out: re-opening the same URL is the safe recovery, and
 * after an interrupted open the session owns no page to snapshot.
 */
const PAGE_MUTATING_COMMANDS: ReadonlySet<BrowserExtensionCommandName> = new Set([
  'click',
  'type',
  'scroll',
]);

/**
 * Extension errors raised by its own cancellation/deadline checkpoints. They
 * can fire after a mutating command's input was dispatched, so for those
 * commands they say no more than a Host-side timeout does.
 */
const EXTENSION_INTERRUPTION_CODES = new Set([
  'browser_command_cancelled',
  'command_expired',
]);

/**
 * Whether a failed page-mutating command may have taken effect:
 * `not_dispatched` when it never reached the extension, `unknown` when it did
 * and ended without a result. Absent for read-only commands, and for errors
 * the extension reports about the action itself.
 */
type BrowserCommandDispatch = 'not_dispatched' | 'unknown';

/** A command failed before it was written to the extension. */
function notDispatchedError(
  command: BrowserExtensionCommandName,
  code: string,
  message: string,
  retryable: boolean,
): BrowserBridgeError {
  return new BrowserBridgeError(
    code,
    message,
    retryable,
    PAGE_MUTATING_COMMANDS.has(command)
      ? { dispatch: 'not_dispatched' satisfies BrowserCommandDispatch }
      : undefined,
  );
}

/**
 * A command reached the extension and ended without a result. Read-only
 * commands stay retryable; a page-mutating one is reported as not retryable,
 * with guidance to observe the page first.
 */
function interruptedError(
  command: BrowserExtensionCommandName,
  code: string,
  message: string,
): BrowserBridgeError {
  if (!PAGE_MUTATING_COMMANDS.has(command)) {
    return new BrowserBridgeError(code, message, true);
  }
  const sentence = /[.!?]$/.test(message) ? message : `${message}.`;
  return new BrowserBridgeError(
    code,
    `${sentence} The ${command} may already have taken effect; take a browser_snapshot`
      + ` to check the page before repeating it.`,
    false,
    { dispatch: 'unknown' satisfies BrowserCommandDispatch },
  );
}

export type BrowserExtensionCommandOptions = {
  /** The caller has already reserved the navigation generation before dispatch. */
  beginNavigation?: boolean;
};

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
  activeTabBinding: 'agent' | 'user' | null;
  userBoundOrigin: string | null;
  stateRevision: number | null;
  capabilities: BrowserExtensionCapability[];
  connectionGeneration?: number;
  targetGeneration?: number;
  navigationGeneration?: number;
  socketPath: string;
};

type PendingCommand = {
  connectionId: string;
  command: BrowserExtensionCommandName;
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
  signal?: AbortSignal;
  abortHandler?: () => void;
};

type BridgeLogger = Pick<Console, 'info' | 'warn' | 'error'>;

export type BrowserExtensionBridgeOptions = {
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

export class BrowserExtensionBridge {
  private readonly socketPath: string;
  private readonly tokenPath: string;
  private readonly commandTimeoutMs: number;
  private readonly logger: BridgeLogger;
  private readonly tokenFactory: () => string;
  private server: Server | null = null;
  private activeSocket: Socket | null = null;
  private readonly sockets = new Set<Socket>();
  private token: string | null = null;
  private registration: BrowserRegisterMessage | null = null;
  private debuggerAttached = false;
  private targetAlive = false;
  private connectionGeneration = 1;
  private targetGeneration = 1;
  /** Tracks the active navigation generation for event stamping. */
  private navigationGeneration = 0;
  /** Navigation generations are isolated per managed browser context. */
  private readonly navigationGenerationsByContext = new Map<string, number>();
  private readonly pending = new Map<string, PendingCommand>();
  private readonly runtimeEventListeners = new Set<(event: BrowserRuntimeEvent) => void>();
  /**
   * Listener set for authoritative generation bumps. Fired when the bridge
   * advances its connection or target generation (extension reconnected, or a
   * managed target closed) so consumers (the controller binding) can fail any
   * in-flight navigation deterministically instead of waiting out its deadline.
   */
  private readonly generationListeners = new Set<(change: {
    connectionGeneration: number;
    targetGeneration: number;
    contextId?: string;
  }) => void>();

  constructor(options: BrowserExtensionBridgeOptions = {}) {
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
      activeTabBinding: activeTab?.binding ?? null,
      userBoundOrigin: this.registration?.state?.userBoundOrigin ?? null,
      stateRevision: this.registration?.state?.revision ?? null,
      capabilities: [...(this.registration?.capabilities ?? [])],
      connectionGeneration: this.connectionGeneration,
      targetGeneration: this.targetGeneration,
      navigationGeneration: this.navigationGeneration,
      socketPath: this.socketPath,
    };
  }

  /**
   * Subscribe to the normalized page-lifecycle event stream. The Runtime
   * consumes these to drive its navigation state machine. Returns an
   * unsubscribe function.
   */
  onRuntimeEvent(listener: (event: BrowserRuntimeEvent) => void): () => void {
    this.runtimeEventListeners.add(listener);
    return () => {
      this.runtimeEventListeners.delete(listener);
    };
  }

  /**
   * Subscribe to authoritative connection/target generation advances. The
   * bridge is the single owner of these counters and knows exactly when they
   * bump: a new active native host replaces the connection
   * (`replaceActiveSocket` / `browser_connection_replaced`) and a managed target
   * closes (`target.closed`). Consumers — primarily the controller binding that
   * also drives `BrowserLifecycleController` — use this to fail an in-flight
   * navigation deterministically (`notifyGenerationAdvance`) so waiters get a
   * definitive `runtime_disconnected` / `target_closed` instead of silence until
   * the deadline (issue #583: on detach/reconnect, "等待者得到确定结果").
   * Returns an unsubscribe function.
   */
  onGenerationChanged(listener: (change: {
    connectionGeneration: number;
    targetGeneration: number;
    contextId?: string;
  }) => void): () => void {
    this.generationListeners.add(listener);
    return () => {
      this.generationListeners.delete(listener);
    };
  }

  /** Fan the latest connection/target generation out to subscribers. */
  private notifyGenerationChanged(contextId?: string) {
    const change = {
      connectionGeneration: this.connectionGeneration,
      targetGeneration: this.targetGeneration,
      ...(contextId ? { contextId } : {}),
    };
    for (const listener of this.generationListeners) {
      listener(change);
    }
  }

  /**
   * Starts a new navigation generation. The bridge stamps every subsequent
   * navigation-scoped event (navigation.*, document.ready, network.activity,
   * dom.changed, popup, download) with this generation so the consumer's
   * `isEventCurrent` can drop late events that belong to a superseded
   * navigation. Returns the new generation.
   *
   * The bridge is the single owner of the navigation generation counter. It is
   * advanced automatically when a `navigate` command is dispatched
   * (`sendCommand('navigate', …)`), and can also be advanced explicitly by
   * caller/embedding code. Consumers should bind the returned value into the
   * controller's `beginNavigation` so both sides agree on the current
   * navigation generation.
   *
   * Known limitation: the counter only advances on `navigate` or an explicit
   * `beginNavigation()` call. Redirects and SPA client-side route changes do
   * not dispatch a `navigate` command, so the driver must call `beginNavigation()`
   * explicitly to demarcate such a boundary — otherwise a late event could be
   * mis-scoped to the previous generation.
   */
  beginNavigation(contextId?: string): number {
    if (!contextId || contextId === BROWSER_LEGACY_CONTEXT_ID) {
      this.navigationGeneration += 1;
      return this.navigationGeneration;
    }
    const next = (this.navigationGenerationsByContext.get(contextId) ?? 0) + 1;
    this.navigationGenerationsByContext.set(contextId, next);
    return next;
  }

  private navigationGenerationFor(contextId?: string): number {
    // The extension stamps the legacy context on events from context-less
    // commands, so it shares the context-less counter those commands advance.
    if (!contextId || contextId === BROWSER_LEGACY_CONTEXT_ID) return this.navigationGeneration;
    return this.navigationGenerationsByContext.get(contextId) ?? 0;
  }

  /**
   * Normalize an extension-reported `browser.event` into the unified Runtime
   * event envelope and fan it out to subscribers. Events are stamped with the
   * current connection + target generation so the consumer's `isEventCurrent`
   * can drop late/out-of-order events. Navigation-scoped events additionally
   * carry the active navigation generation (the bridge owns the counter, and
   * it advances on `beginNavigation()` / `sendCommand('navigate', …)`). The
   * controller binds to that same generation on `beginNavigation`, so the two
   * always agree.
   */
  private emitRuntimeEvent(message: {
    event: BrowserRuntimeEventType;
    contextId?: string;
    tabId?: number;
    url?: string;
    payload?: Record<string, unknown>;
  }) {
    if (this.runtimeEventListeners.size === 0) return;
    const event: BrowserRuntimeEvent = {
      ...(message.contextId ? { contextId: message.contextId } : {}),
      connectionGeneration: this.connectionGeneration,
      targetGeneration: this.targetGeneration,
      tabId: message.tabId ?? this.getStatus().activeTabId ?? 0,
      timestamp: Date.now(),
      ...(NAVIGATION_SCOPED_EVENT_TYPES.has(message.event)
        ? { navigationGeneration: this.navigationGenerationFor(message.contextId) }
        : {}),
      type: message.event,
      ...(message.url !== undefined ? { url: message.url } : {}),
      ...(message.payload !== undefined ? { payload: message.payload } : {}),
    };
    for (const listener of this.runtimeEventListeners) {
      listener(event);
    }
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
    this.rejectPending(
      'browser_bridge_stopped',
      'browser extension bridge stopped',
    );
    for (const socket of this.sockets) socket.destroy();
    this.sockets.clear();
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
    options: BrowserExtensionCommandOptions = {},
  ): Promise<unknown> {
    if (signal?.aborted) {
      throw notDispatchedError(
        command,
        'browser_command_cancelled',
        'Browser command was cancelled before dispatch.',
        true,
      );
    }
    const socket = this.activeSocket;
    const registration = this.registration;
    if (!socket || socket.destroyed || !registration) {
      throw notDispatchedError(
        command,
        'browser_extension_disconnected',
        'Chrome extension is not connected. Install/enable the PinPawo extension and retry.',
        true,
      );
    }
    if (!registration.capabilities.includes(command)) {
      throw notDispatchedError(
        command,
        'browser_extension_unsupported',
        `Chrome extension does not support ${command}`,
        false,
      );
    }
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      throw new Error('browser extension command timeout must be positive');
    }

    // A `navigate` command starts a new navigation: bump the generation so
    // subsequent events (document.ready, network, dom, …) are stamped with it.
    if (command === 'navigate' && options.beginNavigation !== false) {
      const contextId = typeof params.browserContextId === 'string'
        ? params.browserContextId
        : undefined;
      this.beginNavigation(contextId);
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
        rejectPromise(interruptedError(
          command,
          'browser_command_timeout',
          `Chrome extension command ${command} timed out after ${timeoutMs}ms`,
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
        pending.reject(interruptedError(
          command,
          'browser_command_cancelled',
          'Browser command was cancelled.',
        ));
      };
      this.pending.set(requestId, {
        connectionId: registration.connectionId,
        command,
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
        // A failed write never delivered a complete command line.
        pending.reject(notDispatchedError(
          command,
          'browser_bridge_write_failed',
          `failed to send Chrome extension command: ${error.message}`,
          true,
        ));
      });
    });
  }

  private acceptSocket(socket: Socket) {
    this.sockets.add(socket);
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
              if (!this.activeSocket || this.activeSocket.destroyed) {
                this.replaceActiveSocket(socket);
              } else if (this.activeSocket !== socket) {
                this.logger.info(
                  '[browser-bridge] authenticated a candidate native host pending extension registration',
                );
              }
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
      this.sockets.delete(socket);
      if (this.activeSocket === socket) {
        this.activeSocket = null;
        this.registration = null;
        this.debuggerAttached = false;
        this.targetAlive = false;
        this.rejectPending(
          'browser_extension_disconnected',
          'Chrome extension disconnected while a command was running',
        );
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
    this.connectionGeneration += 1;
    this.notifyGenerationChanged();
    this.rejectPending(
      'browser_connection_replaced',
      'Chrome extension connection was replaced',
    );
    this.logger.info('[browser-bridge] native host authenticated');
  }

  private handleExtensionMessage(
    message: ReturnType<typeof parseExtensionToAgentMessage>,
    socket: Socket,
  ) {
    if (socket !== this.activeSocket) {
      if (message.type !== 'browser.register') {
        this.logger.warn('[browser-bridge] ignored message from an inactive native host');
        return;
      }
      if (this.registration && this.registration.extensionId !== message.extensionId) {
        this.logger.warn(
          '[browser-bridge] rejected an additional native host from a different extension',
        );
        socket.destroy();
        return;
      }
      this.replaceActiveSocket(socket);
    }

    if (message.type === 'browser.register') {
      if (this.registration?.connectionId !== message.connectionId) {
        this.rejectPending(
          'browser_connection_replaced',
          'Chrome extension service worker connection changed',
        );
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

    // Keep the legacy boolean bookkeeping so `getStatus()` remains correct,
    // and forward every event to runtime subscribers regardless of whether a
    // state snapshot is present (the modern path used to drop these silently).
    if (message.event === 'debugger.attached') {
      this.debuggerAttached = true;
      this.targetAlive = true;
    } else if (message.event === 'debugger.detached') {
      this.debuggerAttached = false;
      // Chrome detaches for reasons outside the Runtime's control (the user
      // cancelling the debugging bar, the target being replaced); the reason
      // is the only trace of why a later command found no debugger.
      this.logger.info(
        `[browser-bridge] debugger detached tab=${String(message.tabId)} reason=${message.reason ?? 'unknown'}`,
      );
    } else if (message.event === 'target.closed') {
      this.debuggerAttached = false;
      this.targetAlive = false;
      this.targetGeneration += 1;
      this.notifyGenerationChanged(message.contextId);
    } else if (message.event === 'tab.navigated') {
      this.targetAlive = true;
    }

    this.emitRuntimeEvent({
      // The extension still reports navigation via the legacy `tab.navigated`
      // event; map it onto the unified `navigation.committed` so the current
      // controller already reacts to the existing emission path.
      event:
        message.event === 'tab.navigated'
          ? 'navigation.committed'
          : message.event,
      contextId: message.contextId,
      tabId: message.tabId,
      url: message.url,
      payload: message.payload,
    });
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
    if (EXTENSION_INTERRUPTION_CODES.has(message.error!.code)) {
      pending.reject(interruptedError(
        pending.command,
        message.error!.code,
        message.error!.message,
      ));
      return;
    }
    pending.reject(new BrowserBridgeError(
      message.error!.code,
      message.error!.message,
      message.error!.retryable ?? false,
      message.error!.details,
    ));
  }

  /** Every pending command was already written, so each is interrupted. */
  private rejectPending(code: string, message: string) {
    for (const requestId of this.pending.keys()) {
      const pending = this.removePending(requestId);
      if (!pending) continue;
      pending.reject(interruptedError(pending.command, code, message));
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
