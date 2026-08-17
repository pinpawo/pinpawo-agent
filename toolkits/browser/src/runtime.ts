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
  type BrowserOpenOptions,
  type BrowserScrollOptions,
  type BrowserWaitState,
} from './session';
import type { BrowserRuntimeEvent } from './lifecycle/events';
import type {
  BrowserRuntimeCallContext,
  BrowserRuntimePort,
} from './runtimePort';
import {
  configuredBrowserBackend,
  resolveBrowserToolkitOptions,
  type BrowserToolkitOptions,
  type ResolvedBrowserToolkitOptions,
} from './options';

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

export type BrowserRuntimeDependencies = {
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

/**
 * Browser Runtime roots are isolated per Host manager, while the native-host
 * bridge is one process transport bound to a fixed socket. This coordinator
 * lets independent roots lease that transport without making either root own
 * another root's lifecycle.
 *
 * This is a Browser provider detail, not a Host or framework-level Runtime.
 */
class BrowserExtensionBridgeCoordinator {
  readonly bridge: BrowserExtensionBridge;
  private activeLeases = 0;
  private lifecycleTail: Promise<void> = Promise.resolve();

  constructor(bridge: BrowserExtensionBridge = new BrowserExtensionBridge()) {
    this.bridge = bridge;
  }

  acquire(): Promise<void> {
    return this.queueLifecycle(async () => {
      if (this.activeLeases === 0) {
        await this.bridge.start();
      }
      this.activeLeases += 1;
    });
  }

  release(): Promise<void> {
    return this.queueLifecycle(async () => {
      if (this.activeLeases === 0) return;
      this.activeLeases -= 1;
      if (this.activeLeases === 0) {
        await this.bridge.stop();
      }
    });
  }

  private queueLifecycle(operation: () => Promise<void>): Promise<void> {
    const queued = this.lifecycleTail.then(operation, operation);
    this.lifecycleTail = queued.then(
      () => undefined,
      () => undefined,
    );
    return queued;
  }
}

const bridgeCoordinators = new WeakMap<
  BrowserExtensionBridge,
  BrowserExtensionBridgeCoordinator
>();

function coordinatorForBridge(
  bridge: BrowserExtensionBridge,
): BrowserExtensionBridgeCoordinator {
  const existing = bridgeCoordinators.get(bridge);
  if (existing) return existing;
  const coordinator = new BrowserExtensionBridgeCoordinator(bridge);
  bridgeCoordinators.set(bridge, coordinator);
  return coordinator;
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

export class BrowserRuntime implements BrowserRuntimePort {
  private started = false;
  /** One browser workspace per conversation thread. */
  private readonly sessionsByThread = new Map<string, {
    session: BrowserSession;
    workdir: string;
  }>();
  private readonly options: ResolvedBrowserToolkitOptions;
  private readonly bridge: BrowserExtensionBridge;
  private readonly bridgeCoordinator: BrowserExtensionBridgeCoordinator;

  constructor(
    options: BrowserToolkitOptions = {},
    dependencies: BrowserRuntimeDependencies = {},
  ) {
    this.options = resolveBrowserToolkitOptions(options);
    this.bridge = dependencies.bridge ?? new BrowserExtensionBridge();
    this.bridgeCoordinator = coordinatorForBridge(this.bridge);
  }

  private sessionForThread(threadId: string, workdir: string): BrowserSession {
    const existing = this.sessionsByThread.get(threadId);
    if (existing) {
      if (existing.workdir !== workdir) {
        throw new Error(
          `Browser runtime thread "${threadId}" is already bound to workdir "${existing.workdir}".`,
        );
      }
      return existing.session;
    }

    const executionOptions = Object.freeze({
      ...this.options,
      workdir: () => workdir,
    });

    // The extension receives only this opaque id; raw run/delegation tracing
    // metadata never crosses the native host boundary. Its lifetime is the
    // local runtime, which is also the lifetime of the managed browser tabs.
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
    }, executionOptions.workdir);
    const session = new BrowserSession({
      requireExecutionOwner: true,
      getRuntimeSnapshot: () => this.getSnapshot(),
      createChromeExtensionSession: () => extensionSession,
      environment: executionOptions,
    });
    this.sessionsByThread.set(threadId, { session, workdir });
    return session;
  }

  private sessionForCall(context: BrowserRuntimeCallContext) {
    if (!context.threadId.trim()) {
      throw new Error('Browser runtime requires a threadId.');
    }
    if (!context.workdir.trim()) {
      throw new Error('Browser runtime requires a workdir.');
    }
    const session = this.sessionForThread(context.threadId, context.workdir);
    return {
      session,
      owner: { threadId: context.threadId },
    };
  }

  async open(
    context: BrowserRuntimeCallContext,
    url: string,
    options?: BrowserOpenOptions,
  ) {
    const { session, owner } = this.sessionForCall(context);
    return session.open(url, options, owner, context.signal);
  }

  async openWithProfile(
    context: BrowserRuntimeCallContext,
    url: string,
    userDataDir: string,
    options?: Omit<BrowserOpenOptions, 'session' | 'userDataDir'>,
  ) {
    const { session, owner } = this.sessionForCall(context);
    return session.openWithProfile(url, userDataDir, options, owner, context.signal);
  }

  async snapshot(context: BrowserRuntimeCallContext) {
    const { session, owner } = this.sessionForCall(context);
    return session.snapshot(owner, context.signal);
  }

  async click(
    context: BrowserRuntimeCallContext,
    target: string | BrowserElementTarget,
  ) {
    const { session, owner } = this.sessionForCall(context);
    return session.click(target, owner, context.signal);
  }

  async type(
    context: BrowserRuntimeCallContext,
    target: string | BrowserElementTarget,
    text: string,
    submit?: boolean,
  ) {
    const { session, owner } = this.sessionForCall(context);
    return session.type(target, text, submit, owner, context.signal);
  }

  async scroll(
    context: BrowserRuntimeCallContext,
    options?: BrowserScrollOptions,
  ) {
    const { session, owner } = this.sessionForCall(context);
    return session.scroll(options, owner, context.signal);
  }

  async wait(
    context: BrowserRuntimeCallContext,
    target?: string | BrowserElementTarget,
    timeoutMs?: number,
    state?: BrowserWaitState,
  ) {
    const { session, owner } = this.sessionForCall(context);
    return session.wait(target, timeoutMs, state, owner, context.signal);
  }

  async extract(
    context: BrowserRuntimeCallContext,
    options?: BrowserExtractOptions,
  ) {
    const { session, owner } = this.sessionForCall(context);
    return session.extract(options, owner, context.signal);
  }

  async screenshot(context: BrowserRuntimeCallContext) {
    const { session, owner } = this.sessionForCall(context);
    return session.screenshot(owner, context.signal);
  }

  async close(context: BrowserRuntimeCallContext) {
    const { session, owner } = this.sessionForCall(context);
    return session.close(owner, context.signal);
  }

  async listSessions(context: BrowserRuntimeCallContext) {
    const { session } = this.sessionForCall(context);
    return session.listSessions();
  }

  async start(): Promise<void> {
    if (!shouldStartBrowserExtensionBridge(configuredBrowserBackend(this.options))) return;
    if (this.started) return;
    await this.bridgeCoordinator.acquire();
    this.started = true;
  }

  async stop(): Promise<void> {
    try {
      await Promise.all([...this.sessionsByThread.values()].map(async ({ session }) => {
        await session.shutdown();
      }));
      this.sessionsByThread.clear();
    } finally {
      if (this.started) {
        try {
          await this.bridgeCoordinator.release();
        } finally {
          this.started = false;
        }
      }
    }
  }

  getSnapshot(): BrowserRuntimeSnapshot {
    // Runtime state is intentionally not a navigation-state projection. A
    // BrowserRuntime serves several thread-owned tabs, so one unscoped
    // controller here would report the most recently observed thread's
    // readiness as if it described every caller. Per-operation readiness is
    // instead evaluated by the context-filtered ChromeExtensionBrowserSession.
    return projectBrowserRuntimeSnapshot(this.bridge.getStatus());
  }
}

export function shouldStartBrowserExtensionBridge(backend: string): boolean {
  return backend === 'auto' || backend === 'extension';
}
