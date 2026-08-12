import {
  BrowserExtensionBridge,
  type BrowserBridgeStatus,
} from './drivers/chromeExtension/bridge';
import { randomUUID } from 'node:crypto';
import type { BrowserExtensionCapability } from './drivers/chromeExtension/protocol';
import { ChromeExtensionBrowserSession } from './drivers/chromeExtension/session';
import { BrowserSession } from './session';
import type { BrowserExecutionOwner } from './ownership';
import type { BrowserRuntimeEvent } from './lifecycle/events';
import type { ToolkitRuntimeExecutionScope } from '@pinpawo/pet-agent';
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

export type BrowserRuntimeBinding = Readonly<{
  session: BrowserSession;
  owner: BrowserExecutionOwner;
  workdir: () => string;
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

export class BrowserRuntime {
  private started = false;
  /** One browser workspace per conversation thread. */
  private readonly sessionsByThread = new Map<string, BrowserSession>();
  private readonly options: ResolvedBrowserToolkitOptions;
  private readonly bridge: BrowserExtensionBridge;

  constructor(
    options: BrowserToolkitOptions = {},
    dependencies: BrowserRuntimeDependencies = {},
  ) {
    this.options = resolveBrowserToolkitOptions(options);
    this.bridge = dependencies.bridge ?? new BrowserExtensionBridge();
  }

  private sessionForThread(threadId: string): BrowserSession {
    const existing = this.sessionsByThread.get(threadId);
    if (existing) return existing;

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
    }, this.options.workdir);
    const session = new BrowserSession({
      requireExecutionOwner: true,
      getRuntimeSnapshot: () => this.getSnapshot(),
      createChromeExtensionSession: () => extensionSession,
      environment: this.options,
    });
    this.sessionsByThread.set(threadId, session);
    return session;
  }

  async start(): Promise<void> {
    if (!shouldStartBrowserExtensionBridge(configuredBrowserBackend(this.options))) return;
    await this.bridge.start();
    this.started = true;
  }

  async stop(): Promise<void> {
    try {
      await Promise.all([...this.sessionsByThread.values()].map(async (session) => {
        await session.shutdown();
      }));
      this.sessionsByThread.clear();
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

  async resolve(execution: ToolkitRuntimeExecutionScope): Promise<BrowserRuntimeBinding> {
    if (!execution.threadId) {
      throw new Error('Browser runtime requires a threadId.');
    }
    const threadId = execution.threadId;
    const binding = Object.freeze({
      session: this.sessionForThread(threadId),
      owner: {
        threadId,
      },
      workdir: this.options.workdir,
    });
    await binding.session.acquire(binding.owner);
    return binding;
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
