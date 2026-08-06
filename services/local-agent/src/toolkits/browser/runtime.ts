import { getConfig } from '../../config';
import {
  localAgentBrowserBridge,
  type BrowserBridgeStatus,
} from './drivers/chromeExtension/bridge';
import type { BrowserExtensionCapability } from './drivers/chromeExtension/protocol';
import { ChromeExtensionBrowserSession } from './drivers/chromeExtension/session';
import { BrowserSession } from './session';
import type { BrowserExecutionOwner } from './ownership';
import type { ToolkitRuntimeExecutionScope } from '@pinpawo/pet-agent';

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
}>;

export type BrowserRuntimeBinding = Readonly<{
  session: BrowserSession;
  owner: BrowserExecutionOwner;
}>;

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
  });
}

class BrowserRuntime {
  private started = false;
  // The runtime owns the adapter instance so toolkit calls share the same
  // approval and recovery boundary rather than constructing a driver per call.
  private readonly extensionSession = new ChromeExtensionBrowserSession();
  private readonly session: BrowserSession;

  constructor() {
    this.session = new BrowserSession({
      requireExecutionOwner: true,
      getRuntimeSnapshot: () => this.getSnapshot(),
      createChromeExtensionSession: () => this.extensionSession,
    });
  }

  async start(): Promise<void> {
    if (!shouldStartBrowserExtensionBridge(getConfig().browserBackend)) return;
    await localAgentBrowserBridge.start();
    this.started = true;
  }

  async stop(): Promise<void> {
    try {
      await this.session.shutdown();
    } finally {
      if (this.started) {
        try {
          await localAgentBrowserBridge.stop();
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
    });
    await this.session.acquire(binding.owner);
    return binding;
  }

  getSnapshot(): BrowserRuntimeSnapshot {
    return projectBrowserRuntimeSnapshot(localAgentBrowserBridge.getStatus());
  }
}

export function shouldStartBrowserExtensionBridge(backend: string): boolean {
  return backend === 'auto' || backend === 'extension';
}

export const browserRuntime = new BrowserRuntime();
