import {
  BrowserExtensionBridge,
  type BrowserBridgeStatus,
} from './drivers/chromeExtension/bridge';
import { randomUUID } from 'node:crypto';
import type { BrowserExtensionCapability } from './drivers/chromeExtension/protocol';
import { ChromeExtensionBrowserSession } from './drivers/chromeExtension/session';
import {
  BrowserSession,
  type BrowserElementTarget,
  type BrowserExtractOptions,
  type BrowserScrollOptions,
  type BrowserWaitState,
} from './session';
import type { BrowserRuntimeEvent } from './lifecycle/events';
import type { ToolkitAvailability } from '@pinpawo/pet-agent';
import {
  BROWSER_RS_CONTRACT,
  BROWSER_RS_VERSION,
  type BrowserRS,
  type BrowserRSCallContext,
} from './browserRS';

export type BrowserExtensionRuntimeState =
  | 'stopped'
  | 'listening'
  | 'host_connected'
  | 'ready';

export type BrowserExtensionRuntimeSnapshot = Readonly<{
  state: BrowserExtensionRuntimeState;
  detail: string;
  bridgeListening: boolean;
  nativeHostConnected: boolean;
  extensionRegistered: boolean;
  commandReady: boolean;
  debuggerAttached: boolean;
  targetAlive: boolean;
  connectionId: string | null;
  extensionId: string | null;
  activeTabId: number | null;
  activeTabBinding: 'agent' | 'user' | null;
  stateRevision: number | null;
  capabilities: readonly BrowserExtensionCapability[];
  socketPath: string;
}>;

export type BrowserRuntimeSnapshot = Readonly<{
  extension: BrowserExtensionRuntimeSnapshot;
  /** Current navigation readiness as driven by the Runtime lifecycle state
   *  machine (issue #583). `null` when no navigation is in flight. */
  readiness: BrowserReadinessSnapshot | null;
}>;

/** Readiness projection of an in-flight (or just-completed) navigation. */
export type BrowserReadinessSnapshot = Readonly<{
  phase: string | null;
  ready: boolean;
  error?: { code: string; message: string; retryable: boolean };
}>;

export type ChromeExtensionBrowserRSDependencies = {
  bridge?: BrowserExtensionBridge;
};

type BrowserGenerationChange = {
  connectionGeneration: number;
  targetGeneration: number;
  contextId?: string;
};

function resolveBrowserExtensionRuntimeState(
  status: BrowserBridgeStatus,
  commandReady: boolean,
): BrowserExtensionRuntimeState {
  if (!status.listening) return 'stopped';
  if (!status.hostConnected) return 'listening';
  if (!commandReady) return 'host_connected';
  return 'ready';
}

function describeBrowserExtensionStatus(
  state: BrowserExtensionRuntimeState,
  status: BrowserBridgeStatus,
): string {
  if (state === 'ready') {
    return `connected extension ${status.extensionId ?? '(unknown)'}`;
  }
  if (state === 'host_connected') {
    return 'native host connected; waiting for extension registration';
  }
  if (state === 'listening') {
    return `waiting for extension via ${status.socketPath}`;
  }
  return 'browser extension bridge is not running';
}

export function projectBrowserRuntimeSnapshot(
  status: BrowserBridgeStatus,
  readiness: BrowserReadinessSnapshot | null = null,
): BrowserRuntimeSnapshot {
  const commandReady = status.hostConnected && status.extensionConnected;
  const state = resolveBrowserExtensionRuntimeState(status, commandReady);
  return Object.freeze({
    extension: Object.freeze({
      state,
      detail: describeBrowserExtensionStatus(state, status),
      bridgeListening: status.listening,
      nativeHostConnected: status.hostConnected,
      extensionRegistered: status.extensionConnected,
      commandReady,
      debuggerAttached: status.debuggerAttached,
      targetAlive: status.targetAlive,
      connectionId: status.connectionId,
      extensionId: status.extensionId,
      activeTabId: status.activeTabId,
      activeTabBinding: status.activeTabBinding,
      stateRevision: status.stateRevision,
      capabilities: Object.freeze([...status.capabilities]),
      socketPath: status.socketPath,
    }),
    readiness,
  });
}

function describeError(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

/**
 * {@link BrowserRS} over the Chrome extension and its native host.
 *
 * Each Agent session gets one logical session: an isolated browser context in
 * the extension with its own explicitly bound tabs. Logical sessions are
 * established on first use and are never closed by the Host or the Agent.
 *
 * It runs in the RS service (#862), which holds the one extension bridge for
 * every Host; Hosts reach it through `BrowserRSClient`. The instance owns its
 * bridge outright: `start` listens, `dispose` shuts the sessions and stops it.
 * Tests may use it directly as a stand-in.
 */
export class ChromeExtensionBrowserRS implements BrowserRS {
  readonly contract = BROWSER_RS_CONTRACT;
  readonly version = BROWSER_RS_VERSION;

  private started = false;
  private startError: string | null = null;
  private startPromise: Promise<void> | null = null;
  private disposed = false;
  /** One logical session per Agent session. */
  private readonly sessions = new Map<string, BrowserSession>();
  private readonly bridge: BrowserExtensionBridge;

  constructor(dependencies: ChromeExtensionBrowserRSDependencies = {}) {
    this.bridge = dependencies.bridge ?? new BrowserExtensionBridge();
  }

  /**
   * Available once the bridge is listening. Whether the extension is
   * currently connected is not availability: operations report that as a
   * structured, retryable Browser error.
   */
  status(): ToolkitAvailability {
    if (this.disposed) {
      return { available: false, reason: 'Browser RS instance has been disposed.' };
    }
    if (this.startError) {
      return {
        available: false,
        reason: `Browser extension bridge failed to start: ${this.startError}`,
      };
    }
    return { available: true };
  }

  ensureSession(agentSessionId: string): void {
    this.sessionFor(agentSessionId);
  }

  private sessionFor(agentSessionId: string): BrowserSession {
    if (this.disposed) {
      throw new Error('Browser RS instance has been disposed.');
    }
    if (typeof agentSessionId !== 'string' || !agentSessionId.trim()) {
      throw new Error('Browser RS requires an Agent session id.');
    }
    const existing = this.sessions.get(agentSessionId);
    if (existing) return existing;

    // The extension receives only this opaque id; the Agent session id and
    // run/delegation tracing metadata never cross the native host boundary.
    const browserContextId = randomUUID();
    const extensionSession = new ChromeExtensionBrowserSession({
      sendCommand: async (command, params, timeoutMs, signal, commandOptions) => await this.bridge.sendCommand(
        command,
        { ...params, browserContextId },
        timeoutMs,
        signal,
        commandOptions,
      ),
      getStatus: () => this.bridge.getStatus(),
      ...(typeof this.bridge.beginNavigation === 'function'
        ? { beginNavigation: () => this.bridge.beginNavigation(browserContextId) }
        : {}),
      ...(typeof this.bridge.onRuntimeEvent === 'function'
        ? { onRuntimeEvent: (listener: (event: BrowserRuntimeEvent) => void) => this.bridge.onRuntimeEvent((event) => {
            if (event.contextId === browserContextId) listener(event);
          }) }
        : {}),
      ...(typeof this.bridge.onGenerationChanged === 'function'
        ? { onGenerationChanged: (listener: (change: BrowserGenerationChange) => void) => this.bridge.onGenerationChanged((change) => {
            // A target change belongs to one context, whereas a connection change
            // (extension/native-host reconnect) invalidates every in-flight
            // context. The latter has no contextId and must reach all sessions.
            if (!change.contextId || change.contextId === browserContextId) listener(change);
          }) }
        : {}),
    });
    const session = new BrowserSession({
      requireExecutionOwner: true,
      createChromeExtensionSession: () => extensionSession,
    });
    this.sessions.set(agentSessionId, session);
    return session;
  }

  private async sessionForCall(context: BrowserRSCallContext) {
    // Start lazily as well, so a bridge that failed to start with the Host
    // can recover on a later call instead of staying down for the process.
    await this.start();
    const session = this.sessionFor(context.agentSessionId);
    return {
      session,
      owner: { threadId: context.agentSessionId },
    };
  }

  async open(context: BrowserRSCallContext, url: string) {
    const { session, owner } = await this.sessionForCall(context);
    return session.open(url, owner, context.signal);
  }

  async snapshot(context: BrowserRSCallContext) {
    const { session, owner } = await this.sessionForCall(context);
    return session.snapshot(owner, context.signal);
  }

  async click(
    context: BrowserRSCallContext,
    target: string | BrowserElementTarget,
  ) {
    const { session, owner } = await this.sessionForCall(context);
    return session.click(target, owner, context.signal);
  }

  async type(
    context: BrowserRSCallContext,
    target: string | BrowserElementTarget,
    text: string,
    submit?: boolean,
  ) {
    const { session, owner } = await this.sessionForCall(context);
    return session.type(target, text, submit, owner, context.signal);
  }

  async scroll(
    context: BrowserRSCallContext,
    options?: BrowserScrollOptions,
  ) {
    const { session, owner } = await this.sessionForCall(context);
    return session.scroll(options, owner, context.signal);
  }

  async wait(
    context: BrowserRSCallContext,
    target?: string | BrowserElementTarget,
    timeoutMs?: number,
    state?: BrowserWaitState,
  ) {
    const { session, owner } = await this.sessionForCall(context);
    return session.wait(target, timeoutMs, state, owner, context.signal);
  }

  async extract(
    context: BrowserRSCallContext,
    options?: BrowserExtractOptions,
  ) {
    const { session, owner } = await this.sessionForCall(context);
    return session.extract(options, owner, context.signal);
  }

  async screenshot(context: BrowserRSCallContext) {
    const { session, owner } = await this.sessionForCall(context);
    return session.screenshot(owner, context.signal, context.workdir);
  }

  async close(context: BrowserRSCallContext) {
    const { session, owner } = await this.sessionForCall(context);
    return session.close(owner, context.signal);
  }

  /**
   * Start listening for the native host. Idempotent; a failure is recorded as
   * this instance's status instead of failing whoever started it, and the
   * next call retries.
   */
  async start(): Promise<void> {
    if (this.started) return;
    if (this.disposed) throw new Error('Browser RS instance has been disposed.');
    this.startPromise ??= (async () => {
      try {
        await this.bridge.start();
        this.started = true;
        this.startError = null;
      } catch (error) {
        this.startError = describeError(error);
        throw error;
      } finally {
        this.startPromise = null;
      }
    })();
    await this.startPromise;
  }

  /**
   * Shut every logical session and stop the bridge. Owned by the RS service,
   * which calls it when it stops; not a session operation.
   */
  async dispose(): Promise<void> {
    this.disposed = true;
    // A start still in flight would otherwise complete after this check and
    // leave a disposed instance holding a listening bridge. Let it settle
    // first; if it succeeded, the bridge is stopped below.
    const pendingStart = this.startPromise;
    if (pendingStart) await pendingStart.catch(() => undefined);
    try {
      await Promise.all([...this.sessions.values()].map(async (session) => {
        await session.shutdown();
      }));
      this.sessions.clear();
    } finally {
      if (this.started) {
        try {
          await this.bridge.stop();
        } finally {
          this.started = false;
        }
      }
    }
  }

  /** Logical sessions that currently have a page open in the extension. */
  get openSessionCount(): number {
    return [...this.sessions.values()].filter((session) => session.isOpen).length;
  }

  get sessionCount(): number {
    return this.sessions.size;
  }

  getSnapshot(): BrowserRuntimeSnapshot {
    // Instance state is intentionally not a navigation-state projection. One
    // BrowserRS serves several session-owned tabs, so one unscoped
    // controller here would report the most recently observed thread's
    // readiness as if it described every caller. Per-operation readiness is
    // instead evaluated by the context-filtered ChromeExtensionBrowserSession.
    return projectBrowserRuntimeSnapshot(this.bridge.getStatus());
  }
}
