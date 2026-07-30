import { getConfig } from '../../config';
import {
  localAgentBrowserBridge,
  type BrowserBridgeStatus,
} from './drivers/chromeExtension/bridge';

export type BrowserExtensionRuntimeState =
  | 'stopped'
  | 'listening'
  | 'host_connected'
  | 'ready';

export function getBrowserExtensionRuntimeState(
  status: Pick<
    BrowserBridgeStatus,
    'listening' | 'hostConnected' | 'commandReady'
  >,
): BrowserExtensionRuntimeState {
  if (!status.listening) return 'stopped';
  if (!status.hostConnected) return 'listening';
  if (!status.commandReady) return 'host_connected';
  return 'ready';
}

export function describeBrowserExtensionStatus(status: BrowserBridgeStatus): string {
  const runtimeState = getBrowserExtensionRuntimeState(status);
  if (runtimeState === 'ready') {
    return `connected extension ${status.extensionId ?? '(unknown)'}`;
  }
  if (runtimeState === 'host_connected') {
    return 'native host connected; waiting for extension registration';
  }
  if (runtimeState === 'listening') {
    return `waiting for extension via ${status.socketPath}`;
  }
  return 'browser extension bridge is not running';
}

export function buildBrowserExtensionHealthFields(
  status: BrowserBridgeStatus,
): Record<string, unknown> {
  return {
    browser_detail: describeBrowserExtensionStatus(status),
    browser_runtime_state: getBrowserExtensionRuntimeState(status),
    browser_host_connected: status.hostConnected,
    browser_extension_connected: status.extensionConnected,
    browser_command_ready: status.commandReady,
    browser_debugger_attached: status.debuggerAttached,
    browser_target_alive: status.targetAlive,
    browser_active_tab_ownership: status.activeTabOwnership,
    browser_extension_id: status.extensionId,
    browser_state_revision: status.stateRevision,
  };
}

class BrowserRuntime {
  private started = false;

  async start(): Promise<void> {
    if (!shouldStartBrowserExtensionBridge(getConfig().browserBackend)) return;
    await localAgentBrowserBridge.start();
    this.started = true;
  }

  async stop(): Promise<void> {
    if (!this.started) return;
    try {
      await localAgentBrowserBridge.stop();
    } finally {
      this.started = false;
    }
  }

  getExtensionStatus(): BrowserBridgeStatus {
    return localAgentBrowserBridge.getStatus();
  }

  getHealthFields(mode: unknown): Record<string, unknown> {
    if (mode !== 'extension') return {};
    return buildBrowserExtensionHealthFields(this.getExtensionStatus());
  }
}

export function shouldStartBrowserExtensionBridge(backend: string): boolean {
  return backend === 'auto' || backend === 'extension';
}

export const browserRuntime = new BrowserRuntime();
