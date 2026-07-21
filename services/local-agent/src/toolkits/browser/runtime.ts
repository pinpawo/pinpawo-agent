import { getConfig } from '../../config';
import {
  localAgentBrowserBridge,
  type BrowserBridgeStatus,
} from './drivers/chromeExtension/bridge';

class BrowserRuntime {
  private started = false;

  async start(): Promise<void> {
    if (getConfig().browserBackend !== 'extension') return;
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
    const status = this.getExtensionStatus();
    return {
      browser_host_connected: status.hostConnected,
      browser_extension_connected: status.extensionConnected,
      browser_debugger_attached: status.debuggerAttached,
      browser_target_alive: status.targetAlive,
      browser_active_tab_ownership: status.activeTabOwnership,
      browser_extension_id: status.extensionId,
    };
  }
}

export const browserRuntime = new BrowserRuntime();
