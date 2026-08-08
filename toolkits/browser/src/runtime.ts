import {
  BrowserExtensionBridge,
  type BrowserBridgeStatus,
} from './drivers/chromeExtension/bridge';
import type { BrowserExtensionCapability } from './drivers/chromeExtension/protocol';
import { ChromeExtensionBrowserSession } from './drivers/chromeExtension/session';
import { BrowserSession } from './session';
import { BrowserLifecycleController } from './lifecycle/controller';
import { bindBridgeToController } from './lifecycle/bridgeBinding';
import type { BrowserExecutionOwner } from './ownership';
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
  // The runtime owns the adapter instance so toolkit calls share the same
  // approval and recovery boundary rather than constructing a driver per call.
  private readonly extensionSession: ChromeExtensionBrowserSession;
  private readonly session: BrowserSession;
  private readonly options: ResolvedBrowserToolkitOptions;
  private readonly bridge: BrowserExtensionBridge;
  private readonly lifecycle: BrowserLifecycleController;
  private unbindLifecycle: (() => void) | null = null;

  constructor(
    options: BrowserToolkitOptions = {},
    dependencies: BrowserRuntimeDependencies = {},
  ) {
    this.options = resolveBrowserToolkitOptions(options);
    this.bridge = dependencies.bridge ?? new BrowserExtensionBridge();
    this.lifecycle = new BrowserLifecycleController();
    this.extensionSession = new ChromeExtensionBrowserSession(
      this.bridge,
      this.options.workdir,
    );
    this.session = new BrowserSession({
      requireExecutionOwner: true,
      getRuntimeSnapshot: () => this.getSnapshot(),
      createChromeExtensionSession: () => this.extensionSession,
      environment: this.options,
    });
  }

  async start(): Promise<void> {
    if (!shouldStartBrowserExtensionBridge(configuredBrowserBackend(this.options))) return;
    await this.bridge.start();
    // Wire the bridge's normalized event + generation streams into the Runtime
    // lifecycle controller so `browser_open`/readiness is driven from the
    // authoritative event stream (issue #583), not only the extension's
    // `tab.status` polling.
    this.unbindLifecycle = bindBridgeToController(this.bridge, this.lifecycle);
    this.started = true;
  }

  async stop(): Promise<void> {
    try {
      await this.session.shutdown();
    } finally {
      if (this.started) {
        try {
          this.unbindLifecycle?.();
          this.unbindLifecycle = null;
          await this.bridge.stop();
        } finally {
          this.started = false;
        }
      }
    }
  }

  async resolve(execution: ToolkitRuntimeExecutionScope): Promise<BrowserRuntimeBinding> {
    const binding = Object.freeze({
      session: this.session,
      owner: {
        threadId: execution.threadId,
        runId: execution.runId,
        delegationId: execution.delegationId,
      },
      workdir: this.options.workdir,
    });
    await this.session.acquire(binding.owner);
    return binding;
  }

  getSnapshot(): BrowserRuntimeSnapshot {
    const lifecycleSnapshot = this.lifecycle.getSnapshot();
    const nav = lifecycleSnapshot.navigation;
    const readiness: BrowserReadinessSnapshot | null = nav
      ? Object.freeze({
          phase: nav.phase,
          ready: nav.phase === 'readable',
          ...(nav.phase === 'failed' && nav.error
            ? { error: { code: nav.error.code, message: nav.error.message, retryable: nav.error.retryable } }
            : {}),
        })
      : null;
    return projectBrowserRuntimeSnapshot(this.bridge.getStatus(), readiness);
  }
}

export function shouldStartBrowserExtensionBridge(backend: string): boolean {
  return backend === 'auto' || backend === 'extension';
}
